import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";
import type { Services } from "../../../config";
import type { Executor } from "../../../db/client";
import { deckVersions, itemRevisions } from "../../../db/schema";
import { findExposureLeaks } from "../../../domain/lessons/exposure-leaks";
import { lessonCoverageGaps } from "../../../domain/lessons/lesson-coverage";
import { withoutRedundantAcceptedVariants } from "../../../domain/lessons/pool-validation";
import type { LessonExerciseDraft } from "../../../domain/lessons/types";
import { readLessonContext } from "./lesson-api";
import { toExerciseDraft } from "./lesson-drafts";

/**
 * Raport tylko do odczytu: ile ujawnionych rozwiązań mają istniejące szkice lekcji i czy nowa
 * reguła pokrycia (bez ujawnionych ćwiczeń samodzielnych) zablokowałaby ich publikację, a stara
 * nie. Źródło decyzji o wdrożeniu reguły — nic nie zapisuje i nie zwraca treści ćwiczeń.
 */
export interface ExposureReportRow {
  readonly deckVersionId: string;
  readonly deckId: string;
  readonly state: "draft" | "review";
  readonly hardLeaks: number;
  readonly softLeaks: number;
  /** Braki pokrycia po staremu: `poolCoverage` + reguła różnych odpowiedzi szkoły, bez wykluczeń. */
  readonly blockedBefore: boolean;
  /** Braki pokrycia po nowemu (`lessonCoverageGaps`) — to samo sprawdzenie co publikacja. */
  readonly blockedAfter: boolean;
}

export async function reportLessonExposureLeaks(db: Executor, services: Services): Promise<ExposureReportRow[]> {
  const versions = await db
    .select()
    .from(deckVersions)
    .where(and(inArray(deckVersions.state, ["draft", "review"]), isNotNull(deckVersions.lessonContext)))
    .orderBy(asc(deckVersions.createdAt), asc(deckVersions.id));
  const rows: ExposureReportRow[] = [];
  for (const version of versions) {
    const context = readLessonContext(version.lessonContext);
    const subject = services.subjects.getSubject(context.subjectId);
    // Szkic z nieznanego przedmiotu nie ma normalizatora do oceny ujawnień — pomijamy.
    if (!subject) {
      continue;
    }
    const revisions = await db
      .select({ payload: itemRevisions.payload })
      .from(itemRevisions)
      .where(eq(itemRevisions.deckVersionId, version.id))
      .orderBy(asc(itemRevisions.position));
    // Jak publikacja: bez wariantów równoważnych odpowiedzi.
    const exercises: LessonExerciseDraft[] = revisions.map((r) => withoutRedundantAcceptedVariants(toExerciseDraft(r.payload), subject.normalizer));
    const input = { subject, exercises, examples: context.examples, objectiveIds: context.objectiveIds };
    const leaks = findExposureLeaks({ exercises, examples: context.examples, objectiveOrder: context.objectiveIds, subject, mode: "coverage" });
    rows.push({
      deckVersionId: version.id,
      deckId: version.deckId,
      state: version.state as "draft" | "review",
      hardLeaks: leaks.filter((leak) => leak.kind === "hard").length,
      softLeaks: leaks.filter((leak) => leak.kind === "soft").length,
      blockedBefore: lessonCoverageGaps({ ...input, ignoreExposure: true }).length > 0,
      blockedAfter: lessonCoverageGaps(input).length > 0,
    });
  }
  return rows;
}
