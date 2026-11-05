import { describe, expect, it } from "vitest";
import { messages, type LessonGenerationGapDto } from "@learning/contracts";
import {
  GenerationGapBadge, LessonGenerationGapsAlert, generationGapBadgeText, generationGapsAlertText,
} from "./LessonGenerationGaps";
import { renderParentMarkup } from "../test-render";

const gaps: LessonGenerationGapDto[] = [
  { objectiveId: "o1", reason: "incomplete" },
  { objectiveId: "o2", reason: "failed" },
  { objectiveId: "o3", reason: "add_short", added: 3, requested: 8 },
];

describe("niepełna pula po generowaniu agentem", () => {
  it("alert z liczbą zagadnień", () => {
    expect(generationGapsAlertText(gaps)).toBe("Generowanie zakończyło się częściowo: 3 zagadnienia do uzupełnienia. Użyj „Dogeneruj” przy zagadnieniu.");
    // polska odmiana: 1 zagadnienie, 2–4 zagadnienia, 5+ zagadnień
    expect(generationGapsAlertText(gaps.slice(0, 1))).toBe("Generowanie zakończyło się częściowo: 1 zagadnienie do uzupełnienia. Użyj „Dogeneruj” przy zagadnieniu.");
    expect(generationGapsAlertText(gaps.slice(0, 2))).toBe("Generowanie zakończyło się częściowo: 2 zagadnienia do uzupełnienia. Użyj „Dogeneruj” przy zagadnieniu.");
    const five = Array.from({ length: 5 }, (_, i): LessonGenerationGapDto => ({ objectiveId: `o${i}`, reason: "incomplete" }));
    expect(generationGapsAlertText(five)).toBe("Generowanie zakończyło się częściowo: 5 zagadnień do uzupełnienia. Użyj „Dogeneruj” przy zagadnieniu.");
    const markup = renderParentMarkup(<LessonGenerationGapsAlert gaps={gaps} />);
    expect(markup).toContain('data-testid="lesson-generation-gaps"');
    expect(markup).toContain(generationGapsAlertText(gaps));
  });

  it("liczba zagadnień nie powtarza zagadnienia z kilkoma wpisami", () => {
    expect(generationGapsAlertText([...gaps, { objectiveId: "o1", reason: "failed" }])).toContain("3 zagadnienia");
  });

  it("znacznik dla każdego powodu; add_short z liczbami", () => {
    expect(generationGapBadgeText(gaps[0]!)).toBe(messages.lessons.generationGapIncomplete);
    expect(generationGapBadgeText(gaps[1]!)).toBe(messages.lessons.generationGapFailed);
    expect(generationGapBadgeText(gaps[2]!)).toBe("Dodano 3 z 8");
    // stary ładunek bez liczb: nie pokazuje „Dodano undefined z undefined”
    expect(generationGapBadgeText({ objectiveId: "o3", reason: "add_short" })).toBe(messages.lessons.generationGapIncomplete);
  });

  it("znacznik tylko przy zagadnieniu z luką", () => {
    const failed = renderParentMarkup(<GenerationGapBadge objectiveId="o2" gaps={gaps} />);
    expect(failed).toContain('data-testid="objective-gap-o2"');
    expect(failed).toContain('data-reason="failed"');
    expect(failed).toContain('data-tone="danger"');
    const short = renderParentMarkup(<GenerationGapBadge objectiveId="o3" gaps={gaps} />);
    expect(short).toContain("Dodano 3 z 8");
    expect(short).toContain('data-tone="warning"');
    expect(renderParentMarkup(<GenerationGapBadge objectiveId="o4" gaps={gaps} />)).not.toContain("objective-gap");
    expect(renderParentMarkup(<GenerationGapBadge objectiveId="o1" gaps={undefined} />)).not.toContain("objective-gap");
  });
});
