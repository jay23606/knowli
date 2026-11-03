"use client";

import { useId, useState } from "react";
import { Alert, Button, Stack, Text } from "@mantine/core";
import { messages, type LessonReviewDto, type ReviewCategoryDto, type ReviewReasonDto } from "@learning/contracts";
import { ParentIcon } from "../ParentIcon";

/**
 * Podstawia `{klucz}` w szablonie jednym przebiegiem: tekst wstawiony z raportu (np. powód modelu
 * zawierający „{snippet}”) nie jest ponownie podstawiany. Nieznany klucz zostaje bez zmian.
 */
export function fillTemplate(template: string, values: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (Object.hasOwn(values, key) ? String(values[key]) : match));
}

/** Teksty banera kontroli jakości złożone z katalogu komunikatów (bez Reacta — do testów). */
export interface ReviewBannerContent {
  tone: "reviewed" | "attention";
  /** Podsumowanie; null, gdy jedynym ustaleniem są zagadnienia podejrzane (liczby same zera). */
  summary: string | null;
  /** Ćwiczenia dogenerowane pod brakujące etapy (osobny wiersz; także obok „nie znalazła problemów”). */
  toppedUp: string | null;
  /** Zastrzeżenie o zakresie liczb (tylko przy liczbach zmian). */
  scope: string | null;
  partial: string | null;
  suspicious: string[];
  model: string | null;
  dropped: string[];
}

export const reviewReasonLabel = (reason: ReviewReasonDto) => messages.lessons.reviewReason[reason];
export const reviewCategoryLabel = (category: ReviewCategoryDto) => messages.lessons.reviewCategory[category];

export function reviewBannerContent(review: LessonReviewDto): ReviewBannerContent {
  const unreviewed = review.objectives.filter((objective) => objective.status === "unreviewed");
  // Grupy po powodzie w kolejności pierwszego wystąpienia: „{tytuły} ({powód})”, oddzielone „; ”.
  const byReason = new Map<ReviewReasonDto | undefined, string[]>();
  for (const objective of unreviewed) {
    byReason.set(objective.reason, [...(byReason.get(objective.reason) ?? []), objective.title]);
  }
  const suspicious = review.objectives
    .filter((objective) => objective.status === "suspicious")
    .map((objective) => fillTemplate(messages.lessons.reviewSuspicious, { objective: objective.title }));
  const counts = { changed: review.changed.length, dropped: review.dropped.length, notes: review.notes.length };
  const anyCount = Object.values(counts).some((n) => n > 0);
  // „Nie znalazła problemów” tylko przy pełnej kontroli bez zmian i bez zagadnień podejrzanych
  // (dogenerowanie pod brakujące etapy nie jest ustaleniem kontroli — ma własny wiersz).
  const clean = review.status === "reviewed" && !anyCount && suspicious.length === 0;
  const summary = review.status === "unreviewed"
    ? fillTemplate(messages.lessons.reviewUnreviewed, {
        reason: [...byReason.keys()].flatMap((reason) => (reason === undefined ? [] : [reviewReasonLabel(reason)])).join(", "),
      })
    : clean
      ? messages.lessons.reviewBannerClean
      : anyCount || review.status === "partial"
        ? fillTemplate(messages.lessons.reviewBanner, counts)
        : null;
  return {
    tone: review.status === "reviewed" && suspicious.length === 0 ? "reviewed" : "attention",
    summary,
    toppedUp: review.toppedUp > 0 ? fillTemplate(messages.lessons.reviewToppedUp, { toppedUp: review.toppedUp }) : null,
    scope: summary !== null && review.status !== "unreviewed" && !clean ? messages.lessons.reviewBannerScope : null,
    partial: review.status === "partial"
      ? fillTemplate(messages.lessons.reviewPartial, {
          list: [...byReason.entries()]
            .map(([reason, titles]) => (reason === undefined ? titles.join(", ") : `${titles.join(", ")} (${reviewReasonLabel(reason)})`))
            .join("; "),
        })
      : null,
    suspicious,
    model: review.model ? fillTemplate(messages.lessons.reviewModel, { model: review.model }) : null,
    dropped: review.dropped.map((entry) => fillTemplate(messages.lessons.reviewDroppedItem, {
      objective: entry.objectiveTitle,
      category: reviewCategoryLabel(entry.category),
      reason: entry.reasonPl,
      snippet: entry.snippet,
    })),
  };
}

/**
 * Baner automatycznej kontroli jakości szkicu lekcji (PR 2 etapu przeglądu): liczby zmian, zagadnienia
 * niesprawdzone i podejrzane, a w „Szczegółach kontroli” model i usunięte ćwiczenia. Wskazówka, nie błąd —
 * bez `role="alert"`; niebieski dla pełnej kontroli, żółty, gdy część lekcji (zagadnienia niesprawdzone
 * albo podejrzane) wymaga uważniejszego przejrzenia.
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
        {content.summary && <Text size="sm" data-testid="lesson-review-summary">{content.summary}</Text>}
        {content.toppedUp && <Text size="sm" data-testid="lesson-review-topped-up">{content.toppedUp}</Text>}
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
