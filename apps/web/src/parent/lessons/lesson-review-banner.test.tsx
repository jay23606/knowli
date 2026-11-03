import { describe, expect, it } from "vitest";
import { messages, type LessonReviewDto } from "@learning/contracts";
import LessonReviewBanner, { fillTemplate, reviewBannerContent } from "./LessonReviewBanner";
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
    expect(content).toMatchObject({ tone: "reviewed", summary: messages.lessons.reviewBannerClean, toppedUp: null, scope: null, partial: null, suspicious: [] });
    expect(content.model).toBe("Sprawdzał model: anthropic/claude-sonnet-5.5");
  });

  it("dogenerowanie pod etapy nie psuje „nie znalazła problemów” — osobny wiersz z liczbą", () => {
    const content = reviewBannerContent({ ...base, toppedUp: 4 });
    expect(content).toMatchObject({ tone: "reviewed", summary: messages.lessons.reviewBannerClean, scope: null });
    expect(content.toppedUp).toBe("Dogenerowano 4 ćwiczeń, by uzupełnić brakujące etapy.");
    const markup = renderParentMarkup(<LessonReviewBanner review={{ ...base, toppedUp: 4 }} />);
    expect(markup).toContain('data-testid="lesson-review-topped-up"');
    expect(markup).toContain(messages.lessons.reviewBannerClean);
  });

  it("liczby zmian z zastrzeżeniem o zakresie i usuniętymi ćwiczeniami w szczegółach", () => {
    const content = reviewBannerContent({
      ...base,
      changed: [{ exerciseId: EX, category: "ambiguous", reasonPl: "r", beforePl: "b", addedVariants: [] }],
      dropped: [{ objectiveTitle: "Pogoda", category: "wrong_answer", reasonPl: "Błędny klucz.", snippet: "It's ___ → raining" }],
      toppedUp: 3,
    });
    expect(content.summary).toBe("Automatyczna kontrola jakości (łącznie we wszystkich generowaniach) — poprawione: 1 · usunięte: 1 · uwagi: 0.");
    expect(content.toppedUp).toBe("Dogenerowano 3 ćwiczeń, by uzupełnić brakujące etapy.");
    expect(content.scope).toBe(messages.lessons.reviewBannerScope);
    expect(content.scope).toBe("Liczby dotyczą tylko automatycznej kontroli. Ćwiczenia odrzucone, bo rozwiązanie było widoczne wcześniej, znajdziesz w „Powodach odrzuceń przy generowaniu”.");
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
    expect(content.partial).toBe(messages.lessons.reviewPartial.replace("{list}", "Pogoda, Kolory (przekroczony czas); Zwroty (osiągnięto limit sprawdzeń na jedno generowanie)"));
    expect(content.summary).toBe("Automatyczna kontrola jakości (łącznie we wszystkich generowaniach) — poprawione: 0 · usunięte: 0 · uwagi: 0.");
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
  });

  it("zagadnienie podejrzane bez innych ustaleń: żółty ton, sama linia o zagadnieniu, nigdy „nie znalazła problemów”", () => {
    const objectives = [{ objectiveId: "o1", title: "Ubrania", status: "suspicious" as const }, base.objectives[1]!];
    const suspicious = reviewBannerContent({ ...base, objectives });
    expect(suspicious).toMatchObject({
      tone: "attention", summary: null, scope: null,
      suspicious: [messages.lessons.reviewSuspicious.replace("{objective}", "Ubrania")],
    });
    // z liczbami > 0: liczby z zastrzeżeniem zakresu i linia o zagadnieniu
    const withCounts = reviewBannerContent({ ...base, objectives, notes: [{ exerciseId: EX, category: "too_hard", reasonPl: "r", fixRejected: false }] });
    expect(withCounts.tone).toBe("attention");
    expect(withCounts.summary).toBe("Automatyczna kontrola jakości (łącznie we wszystkich generowaniach) — poprawione: 0 · usunięte: 0 · uwagi: 1.");
    expect(withCounts.scope).toBe(messages.lessons.reviewBannerScope);
    expect(withCounts.suspicious).toHaveLength(1);
    // samo dogenerowanie: bez podsumowania liczb, wiersz dogenerowania obok linii o zagadnieniu
    const toppedOnly = reviewBannerContent({ ...base, objectives, toppedUp: 2 });
    expect(toppedOnly).toMatchObject({ summary: null, scope: null, toppedUp: "Dogenerowano 2 ćwiczeń, by uzupełnić brakujące etapy." });
    const markup = renderParentMarkup(<LessonReviewBanner review={{ ...base, objectives }} />);
    expect(markup).not.toContain(messages.lessons.reviewBannerClean);
    expect(markup).not.toContain('data-testid="lesson-review-summary"');
    expect(markup).toContain("--alert-bg:var(--mantine-color-yellow-light)");
  });

  it("szablony podstawiane jednym przebiegiem: tekst modelu z „{snippet}” nie jest podstawiany ponownie", () => {
    expect(fillTemplate("{a} i {b} {c}", { a: "{b}", b: "x" })).toBe("{b} i x {c}");
    const content = reviewBannerContent({
      ...base,
      dropped: [{ objectiveTitle: "{reason}", category: "other", reasonPl: "Zobacz {snippet} i {category}.", snippet: "S" }],
    });
    expect(content.dropped).toEqual(["{reason} — inne: Zobacz {snippet} i {category}. (było: S)"]);
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
