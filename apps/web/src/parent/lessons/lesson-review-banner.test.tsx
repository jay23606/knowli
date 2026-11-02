import { describe, expect, it } from "vitest";
import { messages, type LessonReviewDto } from "@learning/contracts";
import LessonReviewBanner, { reviewBannerContent } from "./LessonReviewBanner";
import { renderParentMarkup } from "../test-render";

const EX = "00000000-0000-4000-8000-000000000001";

const base: LessonReviewDto = {
  status: "reviewed",
  model: "anthropic/claude-sonnet-5.5",
  objectives: [
    { objectiveId: "o1", title: "Ubrania", status: "reviewed" },
    { objectiveId: "o2", title: "Pogoda", status: "reviewed" },
  ],
  changed: [], dropped: [], notes: [], toppedUp: 0,
};

describe("reviewBannerContent", () => {
  it("pełna kontrola bez zmian: komunikat „nie znalazła problemów”, bez zastrzeżenia o zakresie", () => {
    const content = reviewBannerContent(base);
    expect(content).toMatchObject({ tone: "reviewed", summary: messages.lessons.reviewBannerClean, scope: null, partial: null, suspicious: [] });
    expect(content.model).toBe("Sprawdzał model: anthropic/claude-sonnet-5.5");
  });

  it("liczby zmian z zastrzeżeniem o zakresie i usuniętymi ćwiczeniami w szczegółach", () => {
    const content = reviewBannerContent({
      ...base,
      changed: [{ exerciseId: EX, category: "ambiguous", reasonPl: "r", beforePl: "b", addedVariants: [] }],
      dropped: [{ objectiveTitle: "Pogoda", category: "wrong_answer", reasonPl: "Błędny klucz.", snippet: "It's ___ → raining" }],
      toppedUp: 3,
    });
    expect(content.summary).toBe("Automatyczna kontrola jakości — poprawione: 1 · usunięte: 1 · dogenerowane: 3 · uwagi: 0.");
    expect(content.scope).toBe(messages.lessons.reviewBannerScope);
    expect(content.dropped).toEqual(["Pogoda — błędna odpowiedź: Błędny klucz. (było: It's ___ → raining)"]);
  });

  it("część zagadnień niesprawdzona: lista pogrupowana po powodzie, żółty ton", () => {
    const content = reviewBannerContent({
      ...base,
      status: "partial",
      objectives: [
        { objectiveId: "o1", title: "Ubrania", status: "reviewed" },
        { objectiveId: "o2", title: "Pogoda", status: "unreviewed", reason: "timeout" },
        { objectiveId: "o3", title: "Zwroty", status: "unreviewed", reason: "limit" },
        { objectiveId: "o4", title: "Kolory", status: "unreviewed", reason: "timeout" },
      ],
    });
    expect(content.tone).toBe("attention");
    expect(content.partial).toBe(messages.lessons.reviewPartial.replace("{list}", "Pogoda, Kolory (przekroczony czas); Zwroty (osiągnięto limit wywołań)"));
    expect(content.summary).toBe("Automatyczna kontrola jakości — poprawione: 0 · usunięte: 0 · dogenerowane: 0 · uwagi: 0.");
  });

  it("lekcja niesprawdzona: sam komunikat z powodem; zagadnienie podejrzane osobno", () => {
    const unreviewed = reviewBannerContent({
      ...base, status: "unreviewed", model: undefined,
      objectives: base.objectives.map((objective) => ({ ...objective, status: "unreviewed" as const, reason: "not_configured" as const })),
    });
    expect(unreviewed).toMatchObject({
      tone: "attention",
      summary: "Automatyczna kontrola nie sprawdziła tej lekcji (kontrola nie jest skonfigurowana). Przejrzyj ćwiczenia uważniej.",
      scope: null, partial: null, model: null,
    });
    const suspicious = reviewBannerContent({ ...base, objectives: [{ objectiveId: "o1", title: "Ubrania", status: "suspicious" }] });
    expect(suspicious.tone).toBe("reviewed");
    expect(suspicious.suspicious).toEqual([messages.lessons.reviewSuspicious.replace("{objective}", "Ubrania")]);
  });
});

describe("LessonReviewBanner", () => {
  it("baner bez role=alert; „Szczegóły kontroli” zwinięte z aria-expanded i aria-controls", () => {
    const markup = renderParentMarkup(<LessonReviewBanner review={base} />);
    expect(markup).toContain('data-testid="lesson-review-banner"');
    expect(markup).not.toContain('role="alert"');
    expect(markup).toContain('role="note"');
    expect(markup).toContain("--alert-bg:var(--mantine-color-blue-light)");
    const toggle = /<button[^>]*data-testid="lesson-review-details-toggle"[^>]*>/.exec(markup)![0];
    expect(toggle).toContain('aria-expanded="false"');
    const controls = /aria-controls="([^"]+)"/.exec(toggle)![1]!;
    expect(markup).toMatch(new RegExp(`<div[^>]*id="${controls.replace(/[:]/g, "\\:")}"[^>]*hidden`));
  });

  it("żółty baner, gdy kontrola nie objęła całej lekcji; bez szczegółów, gdy nie ma modelu ani usuniętych", () => {
    const markup = renderParentMarkup(<LessonReviewBanner review={{
      ...base, status: "unreviewed", model: undefined,
      objectives: base.objectives.map((objective) => ({ ...objective, status: "unreviewed" as const, reason: "failed" as const })),
    }} />);
    expect(markup).toContain("--alert-bg:var(--mantine-color-yellow-light)");
    expect(markup).not.toContain("lesson-review-details-toggle");
  });
});
