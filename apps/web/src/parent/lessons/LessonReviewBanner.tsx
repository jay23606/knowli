"use client";

import { useId, useState } from "react";
import { Alert, Button, Stack, Text } from "@mantine/core";
import { messages, type LessonReviewDto } from "@learning/contracts";
import { ParentIcon } from "../ParentIcon";

/** Teksty banera kontroli jakości złożone z katalogu komunikatów (bez Reacta — do testów). */
export interface ReviewBannerContent {
  tone: "reviewed" | "attention";
  summary: string;
  /** Zastrzeżenie o zakresie liczb (tylko przy liczbach zmian). */
  scope: string | null;
  partial: string | null;
  suspicious: string[];
  model: string | null;
  dropped: string[];
}

const reasonLabel = (reason: string | undefined) =>
  reason === undefined ? "" : messages.lessons.reviewReason[reason] ?? reason;
const categoryLabel = (category: string) => messages.lessons.reviewCategory[category] ?? category;

export function reviewBannerContent(review: LessonReviewDto): ReviewBannerContent {
  const unreviewed = review.objectives.filter((objective) => objective.status === "unreviewed");
  // Grupy po powodzie w kolejności pierwszego wystąpienia: „{tytuły} ({powód})”, oddzielone „; ”.
  const byReason = new Map<string, string[]>();
  for (const objective of unreviewed) {
    const key = objective.reason ?? "";
    byReason.set(key, [...(byReason.get(key) ?? []), objective.title]);
  }
  const counts = { changed: review.changed.length, dropped: review.dropped.length, toppedUp: review.toppedUp, notes: review.notes.length };
  const clean = review.status === "reviewed" && Object.values(counts).every((n) => n === 0);
  const summary = review.status === "unreviewed"
    ? messages.lessons.reviewUnreviewed.replace("{reason}", () => [...byReason.keys()].map(reasonLabel).filter(Boolean).join(", "))
    : clean
      ? messages.lessons.reviewBannerClean
      : messages.lessons.reviewBanner.replace(/\{(changed|dropped|toppedUp|notes)\}/g, (_match, key: keyof typeof counts) => String(counts[key]));
  return {
    tone: review.status === "reviewed" ? "reviewed" : "attention",
    summary,
    scope: review.status !== "unreviewed" && !clean ? messages.lessons.reviewBannerScope : null,
    partial: review.status === "partial"
      ? messages.lessons.reviewPartial.replace("{list}", () =>
          [...byReason.entries()].map(([reason, titles]) => `${titles.join(", ")} (${reasonLabel(reason || undefined)})`).join("; "))
      : null,
    suspicious: review.objectives
      .filter((objective) => objective.status === "suspicious")
      .map((objective) => messages.lessons.reviewSuspicious.replace("{objective}", () => objective.title)),
    model: review.model ? messages.lessons.reviewModel.replace("{model}", () => review.model!) : null,
    dropped: review.dropped.map((entry) => messages.lessons.reviewDroppedItem
      .replace("{objective}", () => entry.objectiveTitle)
      .replace("{category}", () => categoryLabel(entry.category))
      .replace("{reason}", () => entry.reasonPl)
      .replace("{snippet}", () => entry.snippet)),
  };
}

/**
 * Baner automatycznej kontroli jakości szkicu lekcji (PR 2 etapu przeglądu): liczby zmian, zagadnienia
 * niesprawdzone i podejrzane, a w „Szczegółach kontroli” model i usunięte ćwiczenia. Wskazówka, nie błąd —
 * bez `role="alert"`; niebieski dla pełnej kontroli, żółty, gdy część lekcji wymaga uważniejszego przejrzenia.
 */
export default function LessonReviewBanner({ review }: { review: LessonReviewDto }) {
  const content = reviewBannerContent(review);
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const hasDetails = content.model !== null || content.dropped.length > 0;
  return (
    <Alert color={content.tone === "reviewed" ? "blue" : "yellow"} variant="light" role="note" data-testid="lesson-review-banner"
      data-review-status={review.status} icon={<ParentIcon name={content.tone === "reviewed" ? "info" : "alert-triangle"} />}>
      <Stack gap={6} align="flex-start">
        <Text size="sm" data-testid="lesson-review-summary">{content.summary}</Text>
        {content.scope && <Text size="sm" className="pp-editor-muted" data-testid="lesson-review-scope">{content.scope}</Text>}
        {content.partial && <Text size="sm" data-testid="lesson-review-partial">{content.partial}</Text>}
        {content.suspicious.map((line, i) => <Text key={i} size="sm" data-testid={`lesson-review-suspicious-${i}`}>{line}</Text>)}
        {hasDetails && (
          <>
            <Button size="md" variant="subtle" color={content.tone === "reviewed" ? "blue" : "yellow"} className="pp-lesson-review-toggle"
              data-testid="lesson-review-details-toggle" aria-expanded={open} aria-controls={detailsId}
              onClick={() => setOpen((value) => !value)}>
              {messages.lessons.reviewDetails}
            </Button>
            <div id={detailsId} hidden={!open} data-testid="lesson-review-details">
              {content.model && <Text size="sm" data-testid="lesson-review-model">{content.model}</Text>}
              {content.dropped.length > 0 && (
                <ul className="pp-lesson-rejected-reasons" data-testid="lesson-review-dropped">
                  {content.dropped.map((line, i) => <li key={i}>{line}</li>)}
                </ul>
              )}
            </div>
          </>
        )}
      </Stack>
    </Alert>
  );
}
