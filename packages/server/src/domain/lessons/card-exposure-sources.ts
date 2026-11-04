import type { LessonTopic, SubjectModule } from "./types";

/**
 * Zagadnienie → teksty z kart widoczne dla dziecka jako gotowe rozwiązania
 * (`SubjectModule.cardExposureTexts`). Przedmiot bez haka i zagadnienia bez
 * takich tekstów są pomijane. Czysta funkcja; tylko generowanie.
 */
export function cardExposureSources(
  subject: Pick<SubjectModule, "cardExposureTexts">,
  topic: Pick<LessonTopic, "objectives">,
): Record<string, string[]> {
  const sources: Record<string, string[]> = {};
  if (subject.cardExposureTexts === undefined) return sources;
  for (const objective of topic.objectives) {
    const texts = subject.cardExposureTexts(objective.cards);
    if (texts.length > 0) sources[objective.id] = texts;
  }
  return sources;
}
