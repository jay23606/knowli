import { describe, expect, it } from "vitest";
import type { LessonDeckDto } from "@learning/contracts";
import { lessonPollInterval } from "./LessonEditor";

type Version = NonNullable<LessonDeckDto["draft"]>;

function lesson(overrides: {
  generation?: LessonDeckDto["generation"];
  storyGeneration?: LessonDeckDto["storyGeneration"];
  draftAssets?: string[];
  publishedAssets?: string[];
  draftPromptAudio?: string[];
  draftCardAudio?: string[];
  draftExplanationAudio?: string[];
  draftStoryAudio?: string;
  publishedStoryAudio?: string;
}): LessonDeckDto {
  const version = (states: string[], promptAudio: string[] = [], cardAudio: string[] = [], explanationAudio: string[] = [], storyAudio?: string) => ({
    assets: states.map((state) => ({ state })),
    exercises: [{}, ...promptAudio.map((state) => ({ promptAudio: { state } })), ...explanationAudio.map((state) => ({ explanationAudio: { state } }))],
    cardAudio: cardAudio.map((state) => ({ audio: { state } })),
    ...(storyAudio ? { storyAudio: { state: storyAudio } } : {}),
  }) as unknown as Version;
  return {
    generation: overrides.generation ?? null,
    storyGeneration: overrides.storyGeneration ?? null,
    draft: overrides.draftAssets
      ? version(overrides.draftAssets, overrides.draftPromptAudio, overrides.draftCardAudio, overrides.draftExplanationAudio, overrides.draftStoryAudio)
      : null,
    published: overrides.publishedAssets
      ? version(overrides.publishedAssets, [], [], [], overrides.publishedStoryAudio)
      : null,
  } as unknown as LessonDeckDto;
}

describe("lessonPollInterval", () => {
  it("odpytuje co sekundę, gdy generowanie czeka albo trwa", () => {
    expect(lessonPollInterval(lesson({ generation: { state: "queued" } as LessonDeckDto["generation"] }))).toBe(1000);
    expect(lessonPollInterval(lesson({ generation: { state: "running" } as LessonDeckDto["generation"] }))).toBe(1000);
  });

  it("odpytuje, gdy media pokazanej wersji czekają (szkic przesłania opublikowaną)", () => {
    expect(lessonPollInterval(lesson({ draftAssets: ["approved", "pending"] }))).toBe(1000);
    expect(lessonPollInterval(lesson({ publishedAssets: ["pending"] }))).toBe(1000);
    expect(lessonPollInterval(lesson({ draftAssets: ["approved"], publishedAssets: ["pending"] }))).toBe(false);
  });

  it("nie odpytuje bez danych, po błędzie generowania ani gdy media są gotowe", () => {
    expect(lessonPollInterval(undefined)).toBe(false);
    expect(lessonPollInterval(lesson({ draftAssets: ["approved", "failed"] }))).toBe(false);
    expect(lessonPollInterval(lesson({ generation: { state: "failed" } as LessonDeckDto["generation"], draftAssets: ["approved"] }))).toBe(false);
  });

  it("odpytuje, gdy nagranie pytania albo karty czeka (nie ma ich w assets)", () => {
    // Same nagrania pytań i kart: rzadziej (co 3 s).
    expect(lessonPollInterval(lesson({ draftAssets: ["approved"], draftPromptAudio: ["ready", "pending"] }))).toBe(3000);
    expect(lessonPollInterval(lesson({ draftAssets: ["approved"], draftCardAudio: ["pending"] }))).toBe(3000);
    expect(lessonPollInterval(lesson({ draftAssets: ["pending"], draftCardAudio: ["pending"] }))).toBe(1000);
    expect(lessonPollInterval(lesson({ draftAssets: ["approved"], draftPromptAudio: ["ready", "failed"], draftCardAudio: ["ready"] }))).toBe(false);
  });

  it("odpytuje, gdy nagranie wyjaśnienia czeka", () => {
    expect(lessonPollInterval(lesson({ draftAssets: ["approved"], draftExplanationAudio: ["pending"] }))).toBe(3000);
    expect(lessonPollInterval(lesson({ draftAssets: ["approved"], draftExplanationAudio: ["ready", "failed"] }))).toBe(false);
  });

  it("odpytuje co sekundę, gdy run historyjki czeka albo trwa (osobno od generowania puli)", () => {
    const story = (state: string) => ({ state }) as LessonDeckDto["storyGeneration"];
    expect(lessonPollInterval(lesson({ storyGeneration: story("queued"), draftAssets: ["approved"] }))).toBe(1000);
    expect(lessonPollInterval(lesson({ storyGeneration: story("running"), draftAssets: ["approved"] }))).toBe(1000);
    expect(lessonPollInterval(lesson({ storyGeneration: story("failed"), draftAssets: ["approved"] }))).toBe(false);
    expect(lessonPollInterval(lesson({ storyGeneration: story("succeeded"), draftAssets: ["approved"] }))).toBe(false);
  });

  it("odpytuje, gdy nagranie zdania „Posłuchaj i wybierz” czeka (sentenceAudio, nie ma go w assets)", () => {
    const pending = { draft: { assets: [], exercises: [{ sentenceAudio: { state: "pending" } }] } } as unknown as LessonDeckDto;
    const failed = { draft: { assets: [], exercises: [{ sentenceAudio: { state: "failed" } }] } } as unknown as LessonDeckDto;
    expect(lessonPollInterval(pending)).toBe(3000);
    expect(lessonPollInterval(failed)).toBe(false);
  });

  it("polls every 3 s while only the story recording is pending", () => {
    expect(lessonPollInterval(lesson({ draftAssets: ["approved"], draftStoryAudio: "pending" }))).toBe(3000);
  });

  it("stops polling when the story recording is ready", () => {
    expect(lessonPollInterval(lesson({ draftAssets: ["approved"], draftStoryAudio: "ready" }))).toBe(false);
    expect(lessonPollInterval(lesson({ draftAssets: ["approved"], draftStoryAudio: "failed" }))).toBe(false);
  });

  it("polls every 3 s while the published story recording is pending", () => {
    expect(lessonPollInterval(lesson({ publishedAssets: ["approved"], publishedStoryAudio: "pending" }))).toBe(3000);
    expect(lessonPollInterval(lesson({ publishedAssets: ["approved"], publishedStoryAudio: "ready" }))).toBe(false);
  });

  it("does not poll for a draft without storyAudio", () => {
    expect(lessonPollInterval(lesson({ draftAssets: ["approved"] }))).toBe(false);
  });
});
