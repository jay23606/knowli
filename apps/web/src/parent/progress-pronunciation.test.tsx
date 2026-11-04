import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MantineProvider } from "@mantine/core";
import type { ProgressDto } from "@learning/contracts";
import { PronunciationCard } from "./ProgressPanel";

function render(progress: ProgressDto): string {
  return renderToStaticMarkup(createElement(MantineProvider, null, createElement(PronunciationCard, { progress })));
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
    const markup = render(
      progressWith([
        { target: "apple", score: 92, band: "correct" },
        { target: "banana", score: 64, band: "partial" },
        { target: "cherry", score: 20, band: "below" },
      ]),
    );
    expect(markup).toContain('aria-label="apple: wynik 92 z 100, dobrze"');
    expect(markup).toContain('aria-label="banana: wynik 64 z 100, prawie"');
    expect(markup).toContain('aria-label="cherry: wynik 20 z 100, bez oceny"');
  });
});
