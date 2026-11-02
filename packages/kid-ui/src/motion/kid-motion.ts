import type { Transition } from "motion/react";

/** Motion tokens for Kid UI: the only place with motion numbers.
 * Only transform and opacity are ever animated (geometry stays stable).
 * Damping ratio = damping / (2 * sqrt(stiffness)); below ~0.6 a spring
 * visibly overshoots, which is what makes the child UI feel alive. */
export const kidTapScale = 0.92;
/** Large picture tiles shrink less, so a tap never reads as a jump. */
export const kidTileTapScale = 0.95;
export const kidCoverHoverScale = 1.05;

/** Taps and presses: fast, a small overshoot on release (ratio ~0.54). */
export const kidSpringSnappy: Transition = { type: "spring", stiffness: 520, damping: 24 };
/** Entrances: settles with a soft overshoot (ratio ~0.55). */
export const kidSpringGentle: Transition = { type: "spring", stiffness: 300, damping: 19 };
/** Rewards (icons, stars, pops): a clear bounce (ratio ~0.38). */
export const kidSpringBouncy: Transition = { type: "spring", stiffness: 420, damping: 15.5 };

/** Task switch slides forward: the next task comes in from the right. */
export const kidTaskEnter = { opacity: 1, x: 0 } as const;
export const kidTaskInitial = { opacity: 0, x: 56 } as const;
export const kidTaskExitTarget = { opacity: 0, x: -56 } as const;
export const kidTaskTransition: Transition = { type: "spring", stiffness: 340, damping: 30 };
export const kidTaskExit: Transition = { duration: 0.16, ease: "easeIn" };

export const kidStaggerSeconds = 0.06;
export const kidStaggerMaxIndex = 6;

/** Stagger delay for list entrances; capped so long lists never lag. */
export function kidStaggerDelay(index: number): number {
  return Math.min(Math.max(index, 0), kidStaggerMaxIndex) * kidStaggerSeconds;
}

export const kidEntranceInitial = { opacity: 0, y: 18, scale: 0.94 } as const;
export const kidEntranceAnimate = { opacity: 1, y: 0, scale: 1 } as const;

/** Correct answer: a bouncy pop. A wrong choice keeps the tile still
 * (colour and icon carry the feedback); only its small × icon wobbles once.
 * The shake token below is only for tiny spelling pills. */
export const kidOutcomePop = { scale: [1, 1.12, 0.97, 1] };
export const kidOutcomePopTransition: Transition = { duration: 0.5, ease: "easeOut", times: [0, 0.35, 0.7, 1] };
/** Text options span the whole material column, so a scale pop would push
 * them past the scroller's sides and flash a horizontal scrollbar. They hop
 * upwards instead: moving up never extends a scroll range. */
export const kidOutcomeHop = { y: [0, -8, 2, 0] };
export const kidOutcomeShake = { x: [0, -6, 6, -4, 3, 0] };
export const kidOutcomeShakeTransition: Transition = { duration: 0.42, ease: "easeInOut" };

export const kidOutcomeIconInitial = { opacity: 0, scale: 0.3, rotate: -30 } as const;
export const kidOutcomeIconAnimate = { opacity: 1, scale: 1, rotate: 0 } as const;
/** Wrong-choice icon: pops in, then gives one gentle "no" wobble. */
export const kidWrongIconAnimate = { opacity: 1, scale: 1, rotate: [-30, 16, -12, 6, 0] };
export const kidWrongIconTransition: Transition = { duration: 0.55, ease: "easeOut", times: [0, 0.35, 0.6, 0.8, 1] };
/** Failed manual listen (ListenButton `failKey`): the icon says the same "no"
 * as the wrong-answer badge — same amplitude and timing (mirrored direction) — but starts at rest,
 * without the −30° entrance, because the icon was already on screen. */
export const kidListenFailWobble = { rotate: [0, -16, 12, -6, 0] };
export const kidListenFailWobbleTransition: Transition = { ...kidWrongIconTransition };
/** Feedback heading inside the dock's scrolling card: it only fades and
 * grows towards its resting size (no rotation, no overshoot), so its box
 * never exceeds the card and never opens a transient scroll range. */
export const kidFeedbackTitleInitial = { opacity: 0, scale: 0.85 } as const;
export const kidFeedbackTitleAnimate = { opacity: 1, scale: 1 } as const;
export const kidFeedbackTitleTransition: Transition = { type: "spring", stiffness: 300, damping: 40 };

/** Remaining-tasks pill pops whenever the count changes. */
export const kidProgressPopInitial = { opacity: 0, scale: 0.6 } as const;
export const kidProgressPopAnimate = { opacity: 1, scale: 1 } as const;
/** Session progress fill follows the count with a soft spring. */
export const kidProgressFillTransition: Transition = { type: "spring", stiffness: 160, damping: 20 };
/** A streak of correct answers makes the progress pill jump once. */
export const kidStreakLength = 3;
export const kidStreakJump = { scale: [1, 1.18, 0.95, 1], y: [0, -4, 0, 0] };
/** Pebble row hops (no scaling: the row spans the header column). */
export const kidStreakHop = { y: [0, -4, 0, 0] };
export const kidStreakJumpTransition: Transition = { duration: 0.6, ease: "easeOut", times: [0, 0.35, 0.7, 1] };

/** Flow-screen switch (profile -> decks -> summary); the session screen keeps TaskTransition. */
export const kidScreenInitial = { opacity: 0, y: 20, scale: 0.98 } as const;
export const kidScreenEnter = { opacity: 1, y: 0, scale: 1 } as const;
export const kidScreenExitTarget = { opacity: 0, y: -12, scale: 0.98 } as const;
export const kidScreenTransition: Transition = { type: "spring", stiffness: 320, damping: 28 };
export const kidScreenExit: Transition = { duration: 0.16, ease: "easeIn" };

/** Loading dots bounce in sequence while the first screen loads. */
export const kidLoadingDotAnimate = { opacity: [0.25, 1, 0.25], y: [0, -6, 0] };
export function kidLoadingDotTransition(index: number): Transition {
  return { duration: 0.9, ease: "easeInOut", repeat: Infinity, delay: index * 0.15 };
}

/** A typed letter pops once when it lands in its gap. */
export const kidLetterPop = { scale: [1, 1.25, 0.95, 1] };
export const kidLetterPopTransition: Transition = { duration: 0.4, ease: "easeOut", times: [0, 0.4, 0.75, 1] };

/** Feedback dock grows up from its own bottom edge (transform origin at the
 * bottom) and leaves the same way, faster. It never moves below its resting
 * box: in the flow layout the exercise frame scrolls, and a dock translated
 * downwards would flash a scrollbar for the length of the entrance. */
export const kidDockOrigin = "50% 100%";
export const kidDockInitial = { opacity: 0, scale: 0.9 } as const;
export const kidDockAnimate = { opacity: 1, scale: 1 } as const;
export const kidDockExit = { opacity: 0, scale: 0.94 } as const;
export const kidDockExitTransition: Transition = { duration: 0.14, ease: "easeIn" };

/** End-session confirmation: the scrim fades, the bottom sheet slides up. */
export const kidSheetInitial = { opacity: 0, y: 64 } as const;
export const kidSheetAnimate = { opacity: 1, y: 0 } as const;
export const kidSheetExit = { opacity: 0, y: 64 } as const;
export const kidSheetTransition: Transition = { type: "spring", stiffness: 380, damping: 34 };
export const kidSheetExitTransition: Transition = { duration: 0.16, ease: "easeIn" };
export const kidScrimTransition: Transition = { duration: 0.16, ease: "easeOut" };

/** Idle nudge: after a pause the main action "breathes" to invite a tap.
 * The pause between breaths keeps the button still most of the time, so
 * pointer input (and test runners) always find it at rest. */
export const kidIdleBreath = { scale: [1, 1.05, 1] };
export function kidIdleBreathTransition(delaySeconds = 2.5): Transition {
  return { duration: 0.9, ease: "easeInOut", repeat: Infinity, repeatDelay: 1.8, delay: delaySeconds };
}

/** Audio playing: a soft ring grows out of the button and fades. */
export const kidSoundRingAnimate = { scale: [1, 1.45], opacity: [0.55, 0] };
export const kidSoundRingTransition: Transition = { duration: 1.1, ease: "easeOut", repeat: Infinity };

/** Celebration bursts: particles fly out once and fade.
 * "lg" frames the summary title, "sm" a correct answer. */
export const kidCelebrationDurationSeconds = 0.9;
export function kidCelebrationTransition(index: number, baseDelay = 0.15): Transition {
  return { duration: kidCelebrationDurationSeconds, ease: "easeOut", delay: baseDelay + index * 0.03 };
}
export const kidBurstSizes = {
  sm: { count: 8, distance: 34, spread: 10, particle: 7, baseDelay: 0.05 },
  lg: { count: 16, distance: 64, spread: 22, particle: 10, baseDelay: 0.15 },
} as const;
export type KidBurstSize = keyof typeof kidBurstSizes;
/** Whole burst incl. the last particle's delay, plus a frame of margin. */
export function kidBurstSeconds(size: KidBurstSize): number {
  const { count, baseDelay } = kidBurstSizes[size];
  return baseDelay + (count - 1) * 0.03 + kidCelebrationDurationSeconds + 0.05;
}

/** Summary stars: each lands with a bounce, one after another. */
export const kidStarStaggerSeconds = 0.16;

/** Decorative pair line (matching exercise) appears by fading in; no geometry is animated. */
export const kidFadeInitial = { opacity: 0 } as const;
export const kidFadeAnimate = { opacity: 1 } as const;
export const kidFadeTransition: Transition = { duration: 0.18, ease: "easeOut" };
