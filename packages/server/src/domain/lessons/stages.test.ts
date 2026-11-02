import { describe, expect, it } from "vitest";
import { ASSESSED_STAGES, isAssessed, outsideStagePath, stageOf, STAGE_BY_TYPE } from "./stages";
import type { LessonExerciseType } from "./types";

const ALL_TYPES: LessonExerciseType[] = [
  "lesson_card",
  "lesson_notice",
  "lesson_choice",
  "lesson_order",
  "lesson_short_answer",
  "lesson_gap",
  "lesson_error_fix",
  "lesson_transform",
  "lesson_open_answer",
  "lesson_calculation",
  "lesson_keywords",
  "lesson_match",
  "lesson_group",
  "lesson_cloze",
  "lesson_listen_choice",
];

describe("stageOf / STAGE_BY_TYPE", () => {
  it("mapuje typy na etapy wg tabeli design", () => {
    expect(stageOf("lesson_card")).toBe("intro");
    expect(stageOf("lesson_notice")).toBe("intro");
    expect(stageOf("lesson_choice")).toBe("guided");
    expect(stageOf("lesson_order")).toBe("guided");
    expect(stageOf("lesson_short_answer")).toBe("guided");
    expect(stageOf("lesson_gap")).toBe("productive");
    expect(stageOf("lesson_error_fix")).toBe("productive");
    expect(stageOf("lesson_transform")).toBe("productive");
    expect(stageOf("lesson_open_answer")).toBe("independent");
    expect(stageOf("lesson_calculation")).toBe("independent");
  });

  it("definiuje etap dla każdego typu", () => {
    for (const type of ALL_TYPES) {
      expect(STAGE_BY_TYPE[type]).toBeDefined();
    }
  });
});

describe("lesson_listen_choice", () => {
  it("jest etapem guided", () => {
    expect(stageOf("lesson_listen_choice")).toBe("guided");
  });
  it("outsideStagePath: tylko słuchowy wybór i słowa kluczowe", () => {
    expect(outsideStagePath("lesson_listen_choice")).toBe(true);
    expect(outsideStagePath("lesson_keywords")).toBe(true);
    for (const type of ALL_TYPES.filter((t) => t !== "lesson_listen_choice" && t !== "lesson_keywords")) {
      expect(outsideStagePath(type)).toBe(false);
    }
  });
});

describe("isAssessed", () => {
  it("karta nie jest oceniana; pozostałe typy są", () => {
    expect(isAssessed("lesson_card")).toBe(false);
    for (const type of ALL_TYPES.filter((type) => type !== "lesson_card")) {
      expect(isAssessed(type)).toBe(true);
    }
  });
});

describe("ASSESSED_STAGES", () => {
  it("to dokładnie guided, productive, independent (bez intro)", () => {
    expect([...ASSESSED_STAGES].sort()).toEqual(["guided", "independent", "productive"]);
  });
});
