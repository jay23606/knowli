import { describe, expect, it } from "vitest";
import {
  kidBurstSizes,
  kidCelebrationTransition,
  kidDockAnimate,
  kidDockInitial,
  kidIdleBreath,
  kidIdleBreathTransition,
  kidScreenEnter,
  kidScreenExitTarget,
  kidScreenInitial,
  kidSoundRingAnimate,
  kidSpringBouncy,
  kidSpringGentle,
  kidSpringSnappy,
  kidStreakHop,
  kidStreakJump,
  kidTaskEnter,
  kidTaskExitTarget,
  kidTaskInitial,
  kidWrongIconAnimate,
  kidWrongIconTransition,
  kidListenFailWobble,
  kidListenFailWobbleTransition,
  kidDockExit,
  kidFadeAnimate,
  kidFadeInitial,
  kidEntranceAnimate,
  kidEntranceInitial,
  kidLetterPop,
  kidLoadingDotAnimate,
  kidLoadingDotTransition,
  kidOutcomeIconAnimate,
  kidOutcomeIconInitial,
  kidOutcomePop,
  kidOutcomeShake,
  kidProgressPopAnimate,
  kidProgressPopInitial,
  kidStaggerDelay,
  kidStaggerMaxIndex,
  kidStaggerSeconds,
} from "./kid-motion";

const ANIMATED_VALUES = [
  kidEntranceInitial,
  kidEntranceAnimate,
  kidOutcomePop,
  kidOutcomeShake,
  kidOutcomeIconInitial,
  kidOutcomeIconAnimate,
  kidProgressPopInitial,
  kidProgressPopAnimate,
  kidLetterPop,
  kidDockExit,
  kidLoadingDotAnimate,
  kidWrongIconAnimate,
  kidListenFailWobble,
  kidStreakJump,
  kidStreakHop,
  kidTaskInitial,
  kidTaskEnter,
  kidTaskExitTarget,
  kidScreenInitial,
  kidScreenEnter,
  kidScreenExitTarget,
  kidDockInitial,
  kidDockAnimate,
  kidIdleBreath,
  kidSoundRingAnimate,
  kidFadeInitial,
  kidFadeAnimate,
];

function dampingRatio(spring: { stiffness?: number; damping?: number }): number {
  return spring.damping! / (2 * Math.sqrt(spring.stiffness!));
}

describe("kid motion tokens", () => {
  it("animates only transform and opacity, never layout geometry", () => {
    for (const value of ANIMATED_VALUES) {
      for (const key of Object.keys(value)) {
        expect(["opacity", "scale", "x", "y", "rotate"]).toContain(key);
      }
    }
  });

  it("lets every spring overshoot a little, rewards the most", () => {
    for (const spring of [kidSpringSnappy, kidSpringGentle]) {
      expect(dampingRatio(spring)).toBeGreaterThan(0.45);
      expect(dampingRatio(spring)).toBeLessThan(0.65);
    }
    expect(dampingRatio(kidSpringBouncy)).toBeLessThan(dampingRatio(kidSpringGentle));
  });

  it("keeps idle nudges mostly at rest so the button is easy to hit", () => {
    const breath = kidIdleBreathTransition();
    expect(breath.repeat).toBe(Infinity);
    expect(breath.repeatDelay!).toBeGreaterThan(breath.duration!);
    expect(breath.delay!).toBeGreaterThanOrEqual(2);
  });

  it("keeps the answer burst smaller than the summary burst", () => {
    expect(kidBurstSizes.sm.count).toBeLessThan(kidBurstSizes.lg.count);
    expect(kidBurstSizes.sm.distance).toBeLessThan(kidBurstSizes.lg.distance);
  });

  it("caps stagger delays so long lists never lag behind the child", () => {
    expect(kidStaggerDelay(0)).toBe(0);
    expect(kidStaggerDelay(2)).toBe(2 * kidStaggerSeconds);
    expect(kidStaggerDelay(100)).toBe(kidStaggerMaxIndex * kidStaggerSeconds);
    expect(kidStaggerDelay(-3)).toBe(0);
  });

  it("sequences loading dots and celebration particles deterministically", () => {
    expect(kidLoadingDotTransition(0).delay).toBe(0);
    expect(kidLoadingDotTransition(2).delay).toBeCloseTo(0.3);
    expect(kidLoadingDotTransition(1).repeat).toBe(Infinity);
    expect(kidCelebrationTransition(0).delay).toBeCloseTo(0.15);
    expect(kidCelebrationTransition(3).delay).toBeCloseTo(0.24);
  });

  it("wobbles a failed listen icon with the wrong-answer \"no\" and returns it to rest", () => {
    expect(Object.keys(kidListenFailWobble)).toEqual(["rotate"]);
    expect(kidListenFailWobble.rotate[0]).toBe(0);
    expect(kidListenFailWobble.rotate.at(-1)).toBe(0);
    expect(kidListenFailWobble.rotate).toHaveLength(kidWrongIconAnimate.rotate.length);
    expect(kidListenFailWobbleTransition.duration).toBe(kidWrongIconTransition.duration);
    expect(kidListenFailWobbleTransition.times).toEqual(kidWrongIconTransition.times);
  });
});
