import { and, asc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { MeaningVisualSchema, type KidDeckDto, type KidProfileDto } from "@learning/contracts";
import type { Services } from "../../config";
import type { Tx } from "../../db/client";
import { hasScheduledWork, type DeckWorkloadItem, type SkillSnapshot } from "../../domain/scheduler";
import type { Skill } from "../../domain/types";
import { assignments, childProfiles, deckVersions, decks, itemRevisions, learningSessions, revisionAssets } from "../../db/schema";
import { AppError } from "../../errors";
import { lessonContextOf } from "../learning";
import { readLessonDeckOverviews } from "../learning";
import { CURRENT_POLICY_ID, loadPolicy } from "../../policies/registry";
import { readDeckLearningOverview, readProjectedExposedTargetKeys } from "./deck-learning-overview";
import { SKILL_PROJECTION_VERSION } from "../learning";
import { payloadToItem } from "../materials";
import { localDay } from "../../domain/local-date";
import { validRewardTimezone } from "../../domain/reward-activity";

/**
 * Widoki startowe Kid Mode (arch §12): profile dzieci (tylko nazwa i awatar)
 * oraz opublikowane zestawy przypisane dziecku. Model zaufany — bez autoryzacji
 * dziecka (arch §13); wybór profilu nie jest zabezpieczeniem instancji.
 */
export async function listKidProfiles(services: Services): Promise<KidProfileDto[]> {
  const rows = await services.db
    .select({ childId: childProfiles.id, displayName: childProfiles.displayName, avatarKey: childProfiles.avatarKey, recordingMode: childProfiles.recordingMode, canRead: childProfiles.canRead, rewardPoints: childProfiles.rewardPoints })
    .from(childProfiles)
    .orderBy(asc(childProfiles.createdAt));
  const activityByChild = new Map<string, { seconds: number; unavailable: boolean }>();
  try {
    const today = services.clock.now();
    // UTC window is wider than any civil-day boundary, including UTC-12/UTC+14.
    const sessionWindowStart = new Date(today.getTime() - 48 * 60 * 60_000);
    const todayByChild = new Map(rows.map((row) => [row.childId, { seconds: 0 }]));
    if (rows.length) {
      const sessions = await services.db.select({
        childId: learningSessions.childId, endedAt: learningSessions.endedAt,
        timezone: sql<string | null>`${learningSessions.context}->>'timezone'`,
        reviewStatus: sql<string | null>`${learningSessions.activityReview}->>'status'`,
        approvedSeconds: sql<string | null>`${learningSessions.activityReview}->>'approvedSeconds'`,
      }).from(learningSessions).where(and(
        inArray(learningSessions.childId, rows.map((row) => row.childId)),
        gte(learningSessions.endedAt, sessionWindowStart),
      ));
      for (const session of sessions) {
        if (!session.endedAt) continue;
        const timezone = validRewardTimezone(session.timezone);
        const profileDay = todayByChild.get(session.childId);
        if (!profileDay || localDay(today, timezone) !== localDay(session.endedAt, timezone)) continue;
        const approvedSeconds = session.approvedSeconds === null ? NaN : Number(session.approvedSeconds);
        if (session.reviewStatus === "evaluated" && Number.isSafeInteger(approvedSeconds) && approvedSeconds >= 0) {
          profileDay.seconds += approvedSeconds;
        }
      }
    }
    for (const [childId, summary] of todayByChild) activityByChild.set(childId, { seconds: summary.seconds, unavailable: false });
  } catch {
    // Profil i nauka nadal są dostępne, jeśli odczyt zatwierdzonego czasu zawiedzie.
    for (const row of rows) activityByChild.set(row.childId, { seconds: 0, unavailable: true });
  }
  return rows.map((row) => {
    const activity = activityByChild.get(row.childId);
    // Jeden ogólny licznik dorobku z profilu; bez salda, pakietów i celów dnia.
    return { ...row, todayActivitySeconds: activity?.seconds, todayActivityUnavailable: activity?.unavailable };
  });
}

export async function listKidDecks(services: Services, childId: string, options: { microphoneEnabled?: boolean } = {}): Promise<KidDeckDto[]> {
  const now = services.clock.now();
  return services.db.transaction(tx => listKidDecksSnapshot(services, tx, childId, options, now), {
    isolationLevel: "repeatable read", accessMode: "read only",
  });
}

async function listKidDecksSnapshot(
  services: Services, exec: Tx, childId: string,
  options: { microphoneEnabled?: boolean }, nowDate: Date,
): Promise<KidDeckDto[]> {
  const child = (
    await exec.select({ id: childProfiles.id, policyId: childProfiles.policyId, canRead: childProfiles.canRead, projectionVersion: childProfiles.learningProjectionVersion }).from(childProfiles).where(eq(childProfiles.id, childId))
  )[0];
  if (!child) {
    throw new AppError("not_found");
  }
  if (child.projectionVersion !== SKILL_PROJECTION_VERSION) throw new AppError("conflict", { message: "learning projection rebuild required" });
  const microphoneEnabled = options.microphoneEnabled ?? true;
  const [active] = await exec.select().from(learningSessions).where(and(eq(learningSessions.childId, childId), eq(learningSessions.state, "active")));
  const [activeVersion] = active
    ? await exec.select({ vocabularyFormat: deckVersions.vocabularyFormat, deckKind: decks.kind, coverAssetId: decks.coverAssetId })
        .from(deckVersions).innerJoin(decks, eq(deckVersions.deckId, decks.id)).where(eq(deckVersions.id, active.deckVersionId))
    : [];
  const rows = await exec
    .select({ deckId: decks.id, title: decks.title, kind: decks.kind, coverAssetId: decks.coverAssetId, vocabularyFormat: deckVersions.vocabularyFormat, testDate: assignments.testDate, testGoals: assignments.testGoals, mockTestTaskCount: assignments.mockTestTaskCount, versionId: decks.publishedVersionId, lessonContext: deckVersions.lessonContext })
    .from(assignments)
    .innerJoin(decks, eq(decks.id, assignments.deckId))
    .innerJoin(deckVersions, eq(deckVersions.id, decks.publishedVersionId))
    .where(
      and(
        eq(assignments.childId, childId),
        eq(assignments.active, true),
        isNotNull(decks.publishedVersionId),
      ),
    )
    .orderBy(asc(decks.createdAt));
  const visibleRows = child.canRead
    ? rows
    : rows.filter((row) => row.kind === "vocabulary" && row.vocabularyFormat === "picture" || active?.deckId === row.deckId);
  const coverVersionIds = [...new Set([...visibleRows.map((row) => row.versionId).filter((id): id is string => id !== null), ...(active ? [active.deckVersionId] : [])])];
  const coverRevisions = coverVersionIds.length ? await exec.select({ id: itemRevisions.id, deckVersionId: itemRevisions.deckVersionId, position: itemRevisions.position, payload: itemRevisions.payload })
    .from(itemRevisions).where(inArray(itemRevisions.deckVersionId, coverVersionIds)).orderBy(asc(itemRevisions.position)) : [];
  const illustrationRows = coverRevisions.length ? await exec.select({ itemRevisionId: revisionAssets.itemRevisionId, assetId: revisionAssets.assetId })
    .from(revisionAssets).where(and(inArray(revisionAssets.itemRevisionId, coverRevisions.map((revision) => revision.id)), eq(revisionAssets.role, "illustration"), eq(revisionAssets.state, "approved"))) : [];
  const illustrationByRevision = new Map(illustrationRows.map((row) => [row.itemRevisionId, row.assetId]));
  const coverVisualByVersion = new Map<string, KidDeckDto["coverVisual"]>();
  const coverRevisionCountByVersion = new Map<string, number>();
  for (const revision of coverRevisions) {
    coverRevisionCountByVersion.set(revision.deckVersionId, (coverRevisionCountByVersion.get(revision.deckVersionId) ?? 0) + 1);
    if (coverVisualByVersion.has(revision.deckVersionId)) continue;
    const item = payloadToItem(revision.payload as Record<string, unknown>);
    const visual = item.visualType === "image"
      ? (illustrationByRevision.get(revision.id) ? { kind: "image" as const, imageAssetId: illustrationByRevision.get(revision.id)! } : null)
      : item.visualType === "color"
        ? { kind: "color" as const, color: item.visualData?.color }
        : item.visualType === "number"
          ? { kind: "number" as const, count: item.visualData?.count }
          : null;
    const parsed = MeaningVisualSchema.safeParse(visual);
    coverVisualByVersion.set(revision.deckVersionId, parsed.success ? parsed.data : null);
  }

  // Izolacja lekcji (zadanie 9): rekomendacja i liczniki słówek liczą się TYLKO
  // dla zestawów słówek. Lekcje dostają wartości bezpieczne i tytuł przedmiotu
  // z wstrzykniętego rejestru; prawdziwe liczniki/rekomendację lekcji doda
  // zadanie 13/17. Jedna gałąź po rodzaju zestawu w tym module.
  const vocabRows = visibleRows.filter((row) => row.kind === "vocabulary");

  // Rekomendacja (arch §9.3, §12): czy w wersji jest teraz zaplanowana praca
  // dla tego dziecka? Elementy bez postępu to nowy materiał; rozpoczęte
  // sprawdzamy pod kątem należnych terminów. Utrwalanie dodatkowe jest
  // dostępne zawsze i nie czyni zestawu rekomendowanym.
  const versionIds = [...new Set([
    ...vocabRows.map((row) => row.versionId!),
    ...(active && activeVersion?.deckKind === "vocabulary" ? [active.deckVersionId] : []),
  ])];
  const versionIdSet = new Set(versionIds);
  const revisions = coverRevisions.filter(revision => versionIdSet.has(revision.deckVersionId))
    .map(revision => ({ revisionId: revision.id, versionId: revision.deckVersionId }));
  const now = nowDate.toISOString();
  const policy = await loadPolicy(exec, child.policyId ?? CURRENT_POLICY_ID);
  const snapshots = await readDeckLearningOverview(exec, {
    childId, revisionIds: revisions.map(revision => revision.revisionId),
    revisions: coverRevisions, policy, now,
  });
  const snapshotByRevision = new Map(snapshots.map(snapshot => [snapshot.itemRevisionId, snapshot]));
  const progressByRevision = new Map<string, Array<SkillSnapshot & { skill: Skill }>>(
    snapshots.map(snapshot => [snapshot.itemRevisionId,
      (Object.entries(snapshot.progress) as [Skill, SkillSnapshot][]).map(([skill, progress]) => ({ skill, ...progress })),
    ]),
  );
  const independentlyRecalledRevisions = new Set<string>();
  for (const [revisionId, skillSnapshots] of progressByRevision.entries()) {
    const isMastered = child.canRead
      ? skillSnapshots.some((s) => s.skill === "recall" && s.status === "mastered")
      : skillSnapshots.some((s) => (s.skill === "listening" || s.skill === "recall") && s.status === "mastered");
    if (isMastered) {
      independentlyRecalledRevisions.add(revisionId);
    }
  }
  const itemsByVersion = new Map<string, DeckWorkloadItem[]>();
  for (const revision of revisions) {
    const list = itemsByVersion.get(revision.versionId) ?? [];
    const learning = snapshotByRevision.get(revision.revisionId);
    const scheduledChecks = [learning?.work.recall?.eligibleAt, learning?.work.spelling?.eligibleAt]
      .filter((value): value is string => value !== null && value !== undefined)
      .sort();
    const recognitionStreak = (progressByRevision.get(revision.revisionId) ?? [])
      .filter((snapshot) => snapshot.skill === "listening" || (child.canRead && snapshot.skill === "reading"))
      .reduce((best, snapshot) => Math.max(best, snapshot.streak), 0);
    list.push({
      progress: progressByRevision.get(revision.revisionId) ?? [],
      pendingCheckAt: scheduledChecks[0] ?? null,
      pendingChecks: (["recall", "spelling"] as const).flatMap((skill) => learning?.work[skill]?.eligibleAt
        ? [{ skill, dueAt: learning.work[skill]!.eligibleAt }]
        : []),
      recallIntroductionNeeded: recognitionStreak >= 1 && !learning?.introducedSkills.recall,
    });
    itemsByVersion.set(revision.versionId, list);
  }
  const itemCountByVersion = new Map<string, number>();
  const recalledCountByVersion = new Map<string, number>();
  for (const revision of revisions) {
    itemCountByVersion.set(revision.versionId, (itemCountByVersion.get(revision.versionId) ?? 0) + 1);
    if (independentlyRecalledRevisions.has(revision.revisionId)) {
      recalledCountByVersion.set(
        revision.versionId,
        (recalledCountByVersion.get(revision.versionId) ?? 0) + 1,
      );
    }
  }
  // Lekcje (zadanie 13): prawdziwe liczniki i rekomendacja z silnika lekcji
  // (cele, opanowane cele, czy selektor ma pracę). Jedno wywołanie per lekcja.
  const lessonRows = visibleRows.filter((row) => row.kind === "lesson");
  const lessonValues = await readLessonDeckOverviews(services, exec, {
    childId, now: nowDate,
    decks: lessonRows.map(row => ({
      deckId: row.deckId, versionId: row.versionId!, testDate: row.testDate,
      testGoals: row.testGoals, mockTestTaskCount: row.mockTestTaskCount,
      lessonContext: lessonContextOf(row),
    })),
    readExposedTargetKeys: ({ exec, childId, targetKeys, now }) =>
      readProjectedExposedTargetKeys(exec, childId, targetKeys, now),
  });
  // Zachowujemy kolejność po createdAt (rows), rozgałęziając per rodzaj zestawu.
  const result = visibleRows.map((row): KidDeckDto => {
    const isActive = active?.deckId === row.deckId;
    const versionId = isActive ? active.deckVersionId : row.versionId!;
    const vocabularyFormat = isActive ? activeVersion?.vocabularyFormat ?? row.vocabularyFormat : row.vocabularyFormat;
    const activeSession = isActive ? { sessionId: active.id, mode: active.mode } : null;
    if (row.kind === "lesson") {
      // Tytuł przedmiotu z wstrzykniętego rejestru (NIE import globalny); liczniki
      // lekcji z silnika lekcji (zadanie 13).
      const subjectId = (row.lessonContext as { subjectId?: string } | null)?.subjectId;
      const parentSubjectTitle = (row.lessonContext as { subjectTitlePl?: string } | null)?.subjectTitlePl;
      const subjectTitle = parentSubjectTitle ?? (subjectId ? services.subjects.getSubject(subjectId)?.titlePl : undefined) ?? null;
      const values = lessonValues.get(row.deckId) ?? { itemCount: 0, independentlyRecalledCount: 0, recommended: false, mockTestAvailable: false };
      return {
        kind: "lesson",
        vocabularyFormat,
        coverAssetId: null,
        coverVisual: coverVisualByVersion.get(versionId) ?? null,
        resumeOnly: isActive && !child.canRead,
        subjectTitle,
        mockTestAvailable: child.canRead && values.mockTestAvailable,
        activeSession,
        deckId: row.deckId,
        title: row.title,
        itemCount: values.itemCount,
        independentlyRecalledCount: values.independentlyRecalledCount,
        testDate: row.testDate,
        // Lekcje mają własne tekstowe ćwiczenia i nie wymagają mikrofonu.
        recommended: isActive ? false : values.recommended,
      };
    }
    return {
      kind: "vocabulary",
      vocabularyFormat,
      coverAssetId: isActive ? activeVersion?.coverAssetId ?? row.coverAssetId : row.coverAssetId,
      coverVisual: coverVisualByVersion.get(versionId) ?? null,
      resumeOnly: isActive && !child.canRead,
      subjectTitle: null,
      mockTestAvailable: child.canRead && !!row.testGoals?.length,
      activeSession,
      deckId: row.deckId,
      title: row.title,
      itemCount: isActive ? coverRevisionCountByVersion.get(versionId) ?? 0 : itemCountByVersion.get(versionId) ?? 0,
      independentlyRecalledCount: recalledCountByVersion.get(versionId) ?? 0,
      testDate: row.testDate,
      recommended: !isActive && hasScheduledWork(itemsByVersion.get(row.versionId!) ?? [], now, {
        canRead: child.canRead, microphoneEnabled, vocabularyFormat,
      }),
    };
  });
  if (active && !result.some((deck) => deck.deckId === active.deckId)) {
    const [resumable] = await exec.select({ title: decks.title, kind: decks.kind, coverAssetId: decks.coverAssetId }).from(decks).where(eq(decks.id, active.deckId));
    const [pinnedVersion] = await exec.select({ vocabularyFormat: deckVersions.vocabularyFormat }).from(deckVersions).where(eq(deckVersions.id, active.deckVersionId));
    if (resumable && pinnedVersion) {
      const count = await exec.select({ id: itemRevisions.id }).from(itemRevisions).where(eq(itemRevisions.deckVersionId, active.deckVersionId));
      result.unshift({
        deckId: active.deckId, title: resumable.title, kind: resumable.kind as "vocabulary" | "lesson",
        vocabularyFormat: pinnedVersion.vocabularyFormat, coverAssetId: resumable.coverAssetId, coverVisual: coverVisualByVersion.get(active.deckVersionId) ?? null,
        resumeOnly: true, activeSession: { sessionId: active.id, mode: active.mode }, mockTestAvailable: false,
        itemCount: count.length, independentlyRecalledCount: recalledCountByVersion.get(active.deckVersionId) ?? 0, testDate: null, recommended: false,
        ...(resumable.kind === "lesson" ? { subjectTitle: null } : {}),
      });
    }
  }
  return result;
}
