// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from "vitest";
import { createElement } from "react";
import { render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import type { ProgressDto } from "@learning/contracts";
import { PronunciationCard } from "./ProgressPanel";

beforeAll(() => {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
});

function renderCard(progress: ProgressDto): void {
  render(createElement(MantineProvider, null, createElement(PronunciationCard, { progress })));
}

function progressWith(latestScores: Array<{ target: string; score: number; band: "correct" | "partial" | "below" }>): ProgressDto {
  return {
    pronunciation: {
      assessed: true,
      latestScores: latestScores.map((s) => ({ ...s, provider: "Azure" })),
    },
  } as unknown as ProgressDto;
}

describe("PronunciationCard", () => {
  it("names each score bar with the word, the score on the 0-100 scale and the band", () => {
    renderCard(
      progressWith([
        { target: "apple", score: 92, band: "correct" },
        { target: "banana", score: 64, band: "partial" },
        { target: "cherry", score: 20, band: "below" },
      ]),
    );
    expect(screen.getByRole("img", { name: "apple: wynik 92 z 100, dobrze" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "banana: wynik 64 z 100, prawie" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "cherry: wynik 20 z 100, bez oceny" })).toBeTruthy();
  });
});
