"use client";

import { Alert, Text } from "@mantine/core";
import { messages, type LessonGenerationGapDto } from "@learning/contracts";
import { polishPlural } from "../deck-list-grouping";
import { ParentIcon } from "../ParentIcon";

/** Zagadnienia do uzupełnienia, bez powtórzeń (serwer trzyma jeden wpis na zagadnienie). */
export function generationGapObjectiveCount(gaps: readonly LessonGenerationGapDto[]): number {
  return new Set(gaps.map((gap) => gap.objectiveId)).size;
}

/** Tekst alertu o częściowym generowaniu agentem puli. */
export function generationGapsAlertText(gaps: readonly LessonGenerationGapDto[]): string {
  const count = generationGapObjectiveCount(gaps);
  return messages.lessons.generationGapsAlert[polishPlural(count)]!.replace("{n}", String(count));
}

/** Tekst znacznika zagadnienia; „dodano k z N” bez liczb (stary ładunek) pokazuje się jak niepełne zagadnienie. */
export function generationGapBadgeText(gap: LessonGenerationGapDto): string {
  switch (gap.reason) {
    case "failed":
      return messages.lessons.generationGapFailed;
    case "add_short":
      return gap.added !== undefined && gap.requested !== undefined
        ? messages.lessons.generationGapAddShort.replace("{added}", String(gap.added)).replace("{requested}", String(gap.requested))
        : messages.lessons.generationGapIncomplete;
    default:
      return messages.lessons.generationGapIncomplete;
  }
}

/**
 * Alert szkicu lekcji po częściowym generowaniu agentem puli (spec etapu 2a §11): jedna liczba
 * zagadnień do uzupełnienia i wskazówka, gdzie je dogenerować. Wskazówka, nie błąd — bez `role="alert"`.
 */
export function LessonGenerationGapsAlert({ gaps }: { gaps: readonly LessonGenerationGapDto[] }) {
  return (
    <Alert color="yellow" variant="light" role="note" data-testid="lesson-generation-gaps" icon={<ParentIcon name="alert-triangle" />}>
      <Text size="sm" data-testid="lesson-generation-gaps-text">{generationGapsAlertText(gaps)}</Text>
    </Alert>
  );
}

/** Znacznik zagadnienia obok plakietek pokrycia; `null`, gdy zagadnienie nie ma luki. */
export function GenerationGapBadge({ objectiveId, gaps }: { objectiveId: string; gaps: readonly LessonGenerationGapDto[] | undefined }) {
  const gap = gaps?.find((candidate) => candidate.objectiveId === objectiveId);
  if (!gap) return null;
  return (
    <span className="pp-status-badge" data-tone={gap.reason === "failed" ? "danger" : "warning"} data-reason={gap.reason}
      data-testid={`objective-gap-${objectiveId}`}>
      {generationGapBadgeText(gap)}
    </span>
  );
}
