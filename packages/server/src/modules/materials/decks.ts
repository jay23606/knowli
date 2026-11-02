import { randomUUID } from "node:crypto";
import { AssignmentPutSchema, type AssignmentGoal, type DeckAssignedChildDto, type TestGoal } from "@learning/contracts";
import { and, asc, desc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  CreateEmptyDeckCommandSchema,
  DraftInputSchema,
  DraftPatchSchema,
  isFamilyDate,
  messages,
  type AssignmentDto,
  type CreateEmptyDeckCommand,
  type DeckDto,
  type DeckSettingsPatch,
  type DeckSummaryDto,
  type DraftDto,
  type DraftItemDto,
  type DraftInput,
  type DraftPatch,
  type GenerationDto,
  type VocabularyItemInput,
} from "@learning/contracts";
import type { Services } from "../../config";
import type { Executor, Tx } from "../../db/client";
import {
  assignments,
  childProfiles,
  deckVersions,
  decks,
  generationRuns,
  itemRevisions,
  itemRevisionSkills,
  learningItems,
  learningSessions,
  mediaAssets,
  revisionAssets,
  skillVersions,
} from "../../db/schema";
import { AppError } from "../../errors";
import { buildSkillCriteria, classifyRevisionImpact } from "../../domain/revision-impact";
import { computeTargetKey } from "../../domain/target-key";
import { VOCABULARY_SKILLS, type VocabularySkill } from "../../domain/types";
import { buildPayload, payloadToItem, validateItems } from "./item-payload";
import { assertVocabularyDeck, readDeckKind, readVersionDeckKind } from "./deck-kind";
import { deckStateOf } from "./deck-state";
import { readDeckSource } from "./source-materials";
import { validateVocabularyFormatItems } from "../../domain/picture-vocabulary";
import { assertAssetPublishable, mediaPendingError, reconcileBeforePublish, reconcileDraftAssetsTx, requiredAssetsFor, type AssetRole } from "./media-reconciliation";
import {
  assertEditable,
  bumpEditNumber,
  createVersionFromPublished,
  lockVersion,
} from "./version-ops";

/**
 * Tworzy wersje kryteriów dla wskazanych umiejętności itemu. Numery rewizji
 * podaje się per umiejętność — historie poszczególnych kluczy rozjeżdżają się,
 * gdy część umiejętności zmieniała treść częściej niż pozostałe.
 */
async function createSkillVersionsForItem(
  tx: Tx,
  itemId: string,
  item: VocabularyItemInput,
  skillsToCreate: Map<VocabularySkill, { revisionNumber: number; predecessorId?: string }>,
): Promise<Map<VocabularySkill, string>> {
  const skillIds = new Map<VocabularySkill, string>();
  for (const [skill, meta] of skillsToCreate) {
    const { criteria, criteriaHash } = buildSkillCriteria(item, skill);
    const id = randomUUID();
    await tx.insert(skillVersions).values({
      id,
      itemId,
      skill,
      revisionNumber: meta.revisionNumber,
      criteria,
      criteriaHash,
      ...(meta.predecessorId ? { predecessorId: meta.predecessorId } : {}),
    });
    skillIds.set(skill, id);
  }
  return skillIds;
}

/** Rewizja + mapa skill_versions dla nowego itemu w wersji zestawu. */
async function insertRevision(
  tx: Tx,
  input: {
    itemId: string;
    deckId: string;
    deckVersionId: string;
    position: number;
    item: VocabularyItemInput;
    skillIds: Map<VocabularySkill, string>;
  },
): Promise<string> {
  const revisionId = randomUUID();
  await tx.insert(itemRevisions).values({
    id: revisionId,
    itemId: input.itemId,
    deckId: input.deckId,
    deckVersionId: input.deckVersionId,
    position: input.position,
    payload: buildPayload(input.item),
    targetKey: computeTargetKey(input.item.target, input.item.locales.target),
  });
  for (const skill of VOCABULARY_SKILLS) {
    await tx.insert(itemRevisionSkills).values({
      itemRevisionId: revisionId,
      itemId: input.itemId,
      skill,
      skillVersionId: input.skillIds.get(skill)!,
    });
  }
  return revisionId;
}

/**
 * Odczyt wersji w kształcie DTO. Stan zasobu to projekcja: wiersz może być
 * wciąż pending, podczas gdy gotowy blob w media_assets już czeka — rodzic
 * widzi wtedy "approved". Stan omitted pozostaje decyzją, nie projekcją.
 */
async function readDraftDto(db: Executor, versionId: string): Promise<DraftDto> {
  const version = (await db.select().from(deckVersions).where(eq(deckVersions.id, versionId)))[0];
  if (!version) {
    throw new AppError("not_found");
  }
  const revisions = await db
    .select()
    .from(itemRevisions)
    .where(eq(itemRevisions.deckVersionId, versionId))
    .orderBy(asc(itemRevisions.position));
  const revisionIds = revisions.map((r) => r.id);
  const assets = revisionIds.length
    ? await db
        .select({
          itemRevisionId: revisionAssets.itemRevisionId,
          role: revisionAssets.role,
          decisionState: revisionAssets.state,
          assetId: revisionAssets.assetId,
          assetState: mediaAssets.state,
        })
        .from(revisionAssets)
        .leftJoin(mediaAssets, eq(mediaAssets.id, revisionAssets.assetId))
        .where(inArray(revisionAssets.itemRevisionId, revisionIds))
    : [];

  const items: DraftItemDto[] = revisions.map((r) => ({
    ...payloadToItem(r.payload),
    id: r.itemId,
    revisionId: r.id,
  }));

  return {
    id: version.id,
    deckId: version.deckId,
    editNumber: version.editNumber,
    status: version.state as DraftDto["status"],
    vocabularyFormat: version.vocabularyFormat,
    title: version.title,
    items,
    assets: assets.flatMap((a) => a.role === "prompt_audio" || a.role === "feedback_audio" || a.role === "explanation_audio" ? [] : [{
      itemRevisionId: a.itemRevisionId,
      role: a.role,
      state:
        a.decisionState === "omitted"
          ? "omitted"
          : a.assetState === "ready"
            ? "approved"
            : a.assetState === "failed"
              ? "failed"
              : "pending",
      assetId: a.assetId,
    }]),
  };
}

export async function createDraft(services: Services, input: DraftInput): Promise<DraftDto> {
  const valid = DraftInputSchema.parse(input);
  validateItems(valid.items);
  validateVocabularyFormatItems(valid.vocabularyFormat, valid.items);

  const deckId = randomUUID();
  const versionId = randomUUID();

  return services.db.transaction(async (tx) => {
    await tx.insert(decks).values({ id: deckId, title: valid.title });
    await tx.insert(deckVersions).values({
      id: versionId,
      deckId,
      versionNumber: 1,
      editNumber: 1,
      state: "draft",
      title: valid.title,
      sourceLocale: valid.items[0]!.locales.source,
      targetLocale: valid.items[0]!.locales.target,
      vocabularyFormat: valid.vocabularyFormat,
    });
    for (const [position, item] of valid.items.entries()) {
      const itemId = randomUUID();
      await tx.insert(learningItems).values({ id: itemId, deckId });
      const skillIds = await createSkillVersionsForItem(
        tx,
        itemId,
        item,
        new Map(VOCABULARY_SKILLS.map((skill) => [skill, { revisionNumber: 1 }])),
      );
      await insertRevision(tx, {
        itemId,
        deckId,
        deckVersionId: versionId,
        position,
        item,
        skillIds,
      });
    }
    return readDraftDto(tx, versionId);
  });
}

/**
 * Tworzy ręczny, jeszcze pusty szkic. UUID decku jest kluczem idempotencji:
 * retry nie resetuje treści, niezależnie od tego, jak daleko zaszedł zestaw.
 */
export async function createEmptyDeck(
  services: Services,
  input: CreateEmptyDeckCommand,
): Promise<{ deckId: string; created: boolean }> {
  const command = CreateEmptyDeckCommandSchema.parse(input);
  const title = command.title ?? messages.decks.defaultTitle;
  const versionId = randomUUID();

  return services.db.transaction(async (tx) => {
    const inserted = await tx
      .insert(decks)
      .values({ id: command.deckId, title })
      .onConflictDoNothing({ target: decks.id })
      .returning({ id: decks.id });

    if (inserted.length === 0) {
      return { deckId: command.deckId, created: false };
    }

    await tx.insert(deckVersions).values({
      id: versionId,
      deckId: command.deckId,
      versionNumber: 1,
      editNumber: 1,
      state: "draft",
      title,
      sourceLocale: "pl-PL",
      targetLocale: "en-GB",
      vocabularyFormat: "standard",
    });

    return { deckId: command.deckId, created: true };
  });
}

interface CurrentRevision {
  revisionId: string;
  itemId: string;
  payload: Record<string, unknown>;
  skills: Map<VocabularySkill, { skillVersionId: string; revisionNumber: number }>;
}

/**
 * Kopiuje treść wersji źródłowej do nowej wersji: rewizje elementów, klucze
 * umiejętności (`item_revision_skills`) i decyzje rodzica o mediach
 * (`revision_assets`) — WERBATIM. Kształt tych tabel jest niezależny od rodzaju
 * zestawu (słówka i lekcje różnią się payloadem i zestawem umiejętności, ale nie
 * strukturą rewizji), więc jeden copy działa dla obu rodzajów. Nowe
 * skill_versions z predecessorami powstają dopiero przy edycji szkicu, nie tu.
 */
export async function copyRevisionsSkillsAssets(
  tx: Tx,
  args: { sourceVersionId: string; newVersionId: string; deckId: string },
): Promise<void> {
  const revisions = await tx
    .select()
    .from(itemRevisions)
    .where(eq(itemRevisions.deckVersionId, args.sourceVersionId))
    .orderBy(asc(itemRevisions.position));
  const revisionIds = revisions.map((r) => r.id);
  const skills = revisionIds.length
    ? await tx
        .select({
          itemRevisionId: itemRevisionSkills.itemRevisionId,
          skill: itemRevisionSkills.skill,
          skillVersionId: itemRevisionSkills.skillVersionId,
        })
        .from(itemRevisionSkills)
        .where(inArray(itemRevisionSkills.itemRevisionId, revisionIds))
    : [];
  const assets = revisionIds.length
    ? await tx.select().from(revisionAssets).where(inArray(revisionAssets.itemRevisionId, revisionIds))
    : [];

  for (const revision of revisions) {
    const copyId = randomUUID();
    await tx.insert(itemRevisions).values({
      id: copyId,
      itemId: revision.itemId,
      deckId: args.deckId,
      deckVersionId: args.newVersionId,
      position: revision.position,
      payloadVersion: revision.payloadVersion,
      payload: revision.payload,
      targetKey: revision.targetKey,
    });
    for (const skill of skills.filter((row) => row.itemRevisionId === revision.id)) {
      await tx.insert(itemRevisionSkills).values({
        itemRevisionId: copyId,
        itemId: revision.itemId,
        skill: skill.skill,
        skillVersionId: skill.skillVersionId,
      });
    }
    // decyzje rodzica o mediach (approved/omitted, fingerprinty) przechodzą
    // do szkicu; uzgodnienie przy każdej edycji zadba o zmiany treści
    for (const asset of assets.filter((row) => row.itemRevisionId === revision.id)) {
      await tx.insert(revisionAssets).values({
        itemRevisionId: copyId,
        role: asset.role,
        assetId: asset.assetId,
        expectedFingerprint: asset.expectedFingerprint,
        state: asset.state,
      });
    }
  }
}
/**
 * Nowy edytowalny szkic z aktualnie opublikowanej wersji zestawu słówek
 * (architecture.md §12: POST /decks/:id/draft, SPEC §84). Szkielet wersjonowania
 * (blokada, strażniki, numer wersji) jest wspólny (`createVersionFromPublished`);
 * kopię treści robi `copyRevisionsSkillsAssets`. Opublikowana wersja pozostaje
 * nietknięta i prowadzi sesje dziecka do publikacji nowej.
 */
export async function createDraftFromPublished(
  services: Services,
  deckId: string,
): Promise<DraftDto> {
  const id = z.uuid().parse(deckId);
  return services.db.transaction(async (tx) => {
    assertVocabularyDeck(await readDeckKind(tx, id));
    const newVersionId = await createVersionFromPublished(tx, id, (innerTx, { source, newVersionId }) =>
      copyRevisionsSkillsAssets(innerTx, {
        sourceVersionId: source.id,
        newVersionId,
        deckId: id,
      }),
    );
    return readDraftDto(tx, newVersionId);
  });
}

async function loadCurrentRevisions(tx: Tx, versionId: string): Promise<CurrentRevision[]> {
  const revisions = await tx
    .select()
    .from(itemRevisions)
    .where(eq(itemRevisions.deckVersionId, versionId))
    .orderBy(asc(itemRevisions.position));
  const result: CurrentRevision[] = [];
  for (const r of revisions) {
    const skills = await tx
      .select({
        skill: itemRevisionSkills.skill,
        skillVersionId: itemRevisionSkills.skillVersionId,
        revisionNumber: skillVersions.revisionNumber,
      })
      .from(itemRevisionSkills)
      .innerJoin(skillVersions, eq(skillVersions.id, itemRevisionSkills.skillVersionId))
      .where(eq(itemRevisionSkills.itemRevisionId, r.id));
    result.push({
      revisionId: r.id,
      itemId: r.itemId,
      payload: r.payload,
      skills: new Map(
        skills.map((s) => [
          s.skill as VocabularySkill,
          { skillVersionId: s.skillVersionId, revisionNumber: s.revisionNumber },
        ]),
      ),
    });
  }
  return result;
}

/** Pozycje tymczasowe (1000+) omijają UNIQUE(deck_version_id, position) przy przepisaniu. */
const TEMP_POSITION_OFFSET = 1000;

/** Nadpisuje elementy wersji szkicu; używane też przy zapisie wyniku generacji. */
export async function applyItems(
  tx: Tx,
  versionId: string,
  deckId: string,
  items: VocabularyItemInput[],
): Promise<void> {
  validateItems(items);
  const current = await loadCurrentRevisions(tx, versionId);
  const currentByItemId = new Map(current.map((c) => [c.itemId, c]));

  const referencedIds = new Set(
    items.map((i) => i.id).filter((id): id is string => id !== undefined),
  );
  for (const id of referencedIds) {
    if (!currentByItemId.has(id)) {
      throw new AppError("validation", { message: `unknown item id: ${id}` });
    }
  }

  // elementy usunięte z listy znikają ze szkicu; powiązania zasobów odpinamy
  for (const c of current) {
    if (!referencedIds.has(c.itemId)) {
      await tx.delete(revisionAssets).where(eq(revisionAssets.itemRevisionId, c.revisionId));
      await tx.delete(itemRevisionSkills).where(eq(itemRevisionSkills.itemRevisionId, c.revisionId));
      await tx.delete(itemRevisions).where(eq(itemRevisions.id, c.revisionId));
    }
  }

  for (const [position, item] of items.entries()) {
    const tempPosition = TEMP_POSITION_OFFSET + position;
    if (item.id) {
      const existing = currentByItemId.get(item.id)!;
      const oldItem = payloadToItem(existing.payload);
      const impact = classifyRevisionImpact(oldItem, item);
      const toCreate = new Map<VocabularySkill, { revisionNumber: number; predecessorId: string }>();
      for (const skill of impact) {
        const prev = existing.skills.get(skill)!;
        toCreate.set(skill, {
          revisionNumber: prev.revisionNumber + 1,
          predecessorId: prev.skillVersionId,
        });
      }
      const created = toCreate.size
        ? await createSkillVersionsForItem(tx, existing.itemId, item, toCreate)
        : new Map<VocabularySkill, string>();
      await tx
        .update(itemRevisions)
        .set({
          payload: buildPayload(item),
          targetKey: computeTargetKey(item.target, item.locales.target),
          position: tempPosition,
        })
        .where(eq(itemRevisions.id, existing.revisionId));
      await tx
        .delete(itemRevisionSkills)
        .where(eq(itemRevisionSkills.itemRevisionId, existing.revisionId));
      for (const skill of VOCABULARY_SKILLS) {
        await tx.insert(itemRevisionSkills).values({
          itemRevisionId: existing.revisionId,
          itemId: existing.itemId,
          skill,
          skillVersionId: created.get(skill) ?? existing.skills.get(skill)!.skillVersionId,
        });
      }
    } else {
      const itemId = randomUUID();
      await tx.insert(learningItems).values({ id: itemId, deckId });
      const skillIds = await createSkillVersionsForItem(
        tx,
        itemId,
        item,
        new Map(VOCABULARY_SKILLS.map((skill) => [skill, { revisionNumber: 1 }])),
      );
      await insertRevision(tx, {
        itemId,
        deckId,
        deckVersionId: versionId,
        position: tempPosition,
        item,
        skillIds,
      });
    }
  }

  await tx
    .update(itemRevisions)
    .set({ position: sql`${itemRevisions.position} - ${TEMP_POSITION_OFFSET}` })
    .where(eq(itemRevisions.deckVersionId, versionId));
}

export async function editDraft(
  services: Services,
  draftId: string,
  input: DraftPatch,
): Promise<DraftDto> {
  const valid = DraftPatchSchema.parse(input);
  if (valid.title === undefined && valid.items === undefined) {
    throw new AppError("validation", { message: "patch must change title or items" });
  }

  return services.db.transaction(async (tx) => {
    const version = await lockVersion(tx, draftId);
    assertVocabularyDeck(await readVersionDeckKind(tx, draftId));
    assertEditable(version, valid.expectedEditNumber);
    if (valid.title !== undefined) {
      await tx.update(deckVersions).set({ title: valid.title }).where(eq(deckVersions.id, draftId));
    }
    if (valid.items !== undefined) {
      validateVocabularyFormatItems(version.vocabularyFormat, valid.items);
      await applyItems(tx, draftId, version.deckId, valid.items);
    }
    await bumpEditNumber(tx, draftId);
    // każda edycja uzgadnia powiązania zasobów w tej samej transakcji
    await reconcileDraftAssetsTx(tx, services, version);
    return readDraftDto(tx, draftId);
  });
}

export async function publishDraft(
  services: Services,
  draftId: string,
  expectedEditNumber: number,
): Promise<{ deckVersionId: string }> {
  // Brakujące media zlecamy w osobnej, zatwierdzanej transakcji: nieudana
  // walidacja niżej nie może ich wycofać (issue #106).
  await reconcileBeforePublish(services, draftId, expectedEditNumber);
  return services.db.transaction(async (tx) => {
    const version = await lockVersion(tx, draftId);
    assertVocabularyDeck(await readVersionDeckKind(tx, draftId));
    if (version.state === "published") {
      throw new AppError("conflict");
    }
    if (version.editNumber !== expectedEditNumber) {
      throw new AppError("conflict");
    }
    // Publikacja uzgadnia powiązania zasobów jak każda edycja: promuje gotowe
    // bloby do approved, zanim walidator oceni gotowość. Bez tego zestaw
    // opublikowany zaraz po generacji zostawiałby target_audio w stanie
    // pending i sesje dziecka nie znajdowałyby gotowego audio.
    await reconcileDraftAssetsTx(tx, services, version, { keepFailed: true });

    const revisions = await tx
      .select({
        id: itemRevisions.id,
        itemId: itemRevisions.itemId,
        payload: itemRevisions.payload,
      })
      .from(itemRevisions)
      .where(eq(itemRevisions.deckVersionId, draftId))
      .orderBy(asc(itemRevisions.position));
    if (revisions.length === 0) {
      throw new AppError("validation", { message: "deck has no items" });
    }
    if (version.vocabularyFormat === "picture") {
      validateVocabularyFormatItems("picture", revisions.map((revision) => payloadToItem(revision.payload)));
    }
    const revisionIds = revisions.map((r) => r.id);
    const assets = await tx
      .select()
      .from(revisionAssets)
      .where(inArray(revisionAssets.itemRevisionId, revisionIds));

    // Walidator publikacji: obowiązkowe audio gotowe i zgodne z fingerprintem,
    // obraz świadomie pominięty albo gotowy. Wymagany TTS nie może być pominięty.
    const settings = services.media;
    let firstPending: { role: AssetRole; itemRevisionId: string } | null = null;
    for (const revision of revisions) {
      const mine = assets.filter((a) => a.itemRevisionId === revision.id);
      const requiredHere = settings
        ? new Map(
            requiredAssetsFor(payloadToItem(revision.payload), settings).map((r) => [r.role, r]),
          )
        : null;

      const checkLinked = async (
        role: "target_audio" | "example_audio" | "illustration",
      ): Promise<void> => {
        const row = mine.find((a) => a.role === role);
        if (!row || row.assetId === null) {
          throw new AppError("validation", {
            message: `missing ready ${role} for revision ${revision.id}`,
          });
        }
        const status = await assertAssetPublishable(tx, {
          itemRevisionId: revision.id,
          role,
          assetId: row.assetId,
          expectedFingerprint: row.expectedFingerprint,
          linkState: row.state,
        });
        if (status === "pending") firstPending ??= { role, itemRevisionId: revision.id };
        const required = requiredHere?.get(role);
        if (requiredHere && (!required || required.fingerprint !== row.expectedFingerprint)) {
          throw new AppError("validation", {
            message: `stale ${role} link for revision ${revision.id}`,
          });
        }
      };

      await checkLinked("target_audio");

      // decyzja o obrazie jest potrzebna tylko, gdy karta naprawdę go wymaga;
      // kolor/liczba/sekwencja renderują się deterministycznie
      const illustration = mine.find((a) => a.role === "illustration");
      const illustrationRequired = requiredHere ? requiredHere.has("illustration") : true;
      if (illustrationRequired) {
        if (!illustration) {
          throw new AppError("validation", {
            message: `illustration not decided for revision ${revision.id}`,
          });
        }
        if (illustration.state === "omitted" && version.vocabularyFormat === "picture") {
          throw new AppError("validation", {
            message: `picture vocabulary requires illustration for revision ${revision.id}`,
          });
        }
        if (illustration.state !== "omitted") {
          await checkLinked("illustration");
        }
      }

      const exampleAudio = mine.find((a) => a.role === "example_audio");
      if (exampleAudio && exampleAudio.state !== "omitted") {
        await checkLinked("example_audio");
      }
    }

    // generacja zgłaszana po wszystkich kartach: inny błąd ma pierwszeństwo
    if (firstPending) throw mediaPendingError(firstPending);

    const now = services.clock.now();
    await tx
      .update(deckVersions)
      .set({ state: "published", publishedAt: now })
      .where(eq(deckVersions.id, draftId));
    await tx
      .update(decks)
      .set({ publishedVersionId: draftId, title: version.title })
      .where(eq(decks.id, version.deckId));
    await tx
      .update(learningItems)
      .set({ retiredAt: now })
      .where(
        and(
          eq(learningItems.deckId, version.deckId),
          isNull(learningItems.retiredAt),
          notInArray(
            learningItems.id,
            revisions.map((r) => r.itemId),
          ),
        ),
      );
    return { deckVersionId: draftId };
  });
}

/** Odczyt istniejącego szkicu/wersji — podgląd i polling po odświeżeniu strony. */
export async function readDraft(services: Services, draftId: string): Promise<DraftDto> {
  return readDraftDto(services.db, z.uuid().parse(draftId));
}

/** Najnowszy run generacji zestawu dla wersji; brak runów daje null. */
async function latestDeckRun(db: Executor, deckVersionId: string): Promise<GenerationDto | null> {
  const run = (
    await db
      .select()
      .from(generationRuns)
      .where(and(eq(generationRuns.deckVersionId, deckVersionId), eq(generationRuns.kind, "deck")))
      .orderBy(desc(generationRuns.createdAt))
      .limit(1)
  )[0];
  if (!run) {
    return null;
  }
  return {
    id: run.id,
    deckId: (
      await db
        .select({ deckId: deckVersions.deckId })
        .from(deckVersions)
        .where(eq(deckVersions.id, deckVersionId))
    )[0]?.deckId ?? null,
    deckVersionId: run.deckVersionId ?? null,
    state: run.state as GenerationDto["state"],
    attempts: run.attempts,
    errorCode: run.errorCode ?? null,
    rejectedCount: run.rejectedCount ?? null,
  };
}

async function deckAssignments(db: Executor, deckId: string): Promise<AssignmentDto[]> {
  return db
    .select({
      childId: assignments.childId,
      displayName: childProfiles.displayName,
      testDate: assignments.testDate,
      testGoals: assignments.testGoals,
      mockTestTaskCount: assignments.mockTestTaskCount,
      active: assignments.active,
    })
    .from(assignments)
    .innerJoin(childProfiles, eq(childProfiles.id, assignments.childId))
    .where(and(eq(assignments.deckId, deckId), eq(assignments.active, true)))
    .orderBy(asc(childProfiles.createdAt), asc(childProfiles.id));
}

/**
 * Pełny widok zestawu dla panelu rodzica: edytowalny szkic, opublikowana wersja,
 * najnowszy run generacji szkicu i przypisania dzieci z terminami. Zestaw
 * utworzony ze źródła rodzica ma `source` (tytuł i rewizje treści z żywego
 * źródła); pole znika, gdy źródło usunięto, a zestaw z opisu albo ręczny go nie ma.
 */
export async function readDeck(services: Services, deckId: string): Promise<DeckDto> {
  const id = z.uuid().parse(deckId);
  // Run state and draft contents must come from one snapshot. Otherwise a GET
  // can read empty items before generation commits, then read succeeded after
  // commit; the editor stops polling with a permanently empty form.
  return services.db.transaction((tx) => readDeckSnapshot(tx, id), {
    isolationLevel: "repeatable read",
    accessMode: "read only",
  });
}

async function readDeckSnapshot(db: Executor, id: string): Promise<DeckDto> {
  const deck = (await db.select().from(decks).where(eq(decks.id, id)))[0];
  if (!deck) {
    throw new AppError("not_found");
  }
  assertVocabularyDeck(deck.kind as "vocabulary" | "lesson");
  const editable = (
    await db
      .select()
      .from(deckVersions)
      .where(and(eq(deckVersions.deckId, id), inArray(deckVersions.state, ["draft", "review"])))
  )[0];
  const publishedVersionId = deck.publishedVersionId ?? null;
  const source = await readDeckSource(db, deck);
  return {
    id: deck.id,
    title: deck.title,
    coverAssetId: deck.coverAssetId,
    sessionTaskBudget: deck.sessionTaskBudget,
    state: deckStateOf(deck, editable ? (editable.state as "draft" | "review") : null),
    draft: editable ? await readDraftDto(db, editable.id) : null,
    published: publishedVersionId ? await readDraftDto(db, publishedVersionId) : null,
    generation: editable ? await latestDeckRun(db, editable.id) : null,
    assignments: await deckAssignments(db, id),
    ...(source === undefined ? {} : { source }),
  };
}

/** Lista zestawów najnowszymi pierwszymi; stan wynika z wersji i archiwum. */
export async function listDecks(services: Services): Promise<DeckSummaryDto[]> {
  const rows = await services.db
    .select({
      id: decks.id,
      title: decks.title,
      kind: decks.kind,
      coverAssetId: decks.coverAssetId,
      sessionTaskBudget: decks.sessionTaskBudget,
      archivedAt: decks.archivedAt,
      publishedVersionId: decks.publishedVersionId,
    })
    .from(decks)
    .orderBy(desc(decks.createdAt));
  const versions = await services.db
    .select({ deckId: deckVersions.deckId, id: deckVersions.id, state: deckVersions.state, vocabularyFormat: deckVersions.vocabularyFormat })
    .from(deckVersions);
  const editable = versions.filter((version) => version.state === "draft" || version.state === "review");
  const versionById = new Map(versions.map((version) => [version.id, version]));
  const editableByDeck = new Map(editable.map((v) => [v.deckId, v]));

  // Meta listy zbiorczo (bez N+1): licznik pozycji wersji reprezentatywnych
  // oraz aktywne przypisania z imionami dzieci, w kolejności deckAssignments.
  const representativeVersionIds = [
    ...new Set(
      rows.map((row) => row.publishedVersionId ?? editableByDeck.get(row.id)?.id ?? null).filter((id): id is string => id !== null),
    ),
  ];
  const countByVersion = new Map<string, number>(
    representativeVersionIds.length
      ? await services.db
          .select({ versionId: itemRevisions.deckVersionId, count: sql<number>`count(*)::int` })
          .from(itemRevisions)
          .where(inArray(itemRevisions.deckVersionId, representativeVersionIds))
          .groupBy(itemRevisions.deckVersionId)
          .then((counts) => counts.map((row): [string, number] => [row.versionId, row.count]))
      : [],
  );
  const assignmentRows = await services.db
    .select({
      deckId: assignments.deckId,
      childId: assignments.childId,
      displayName: childProfiles.displayName,
      testDate: assignments.testDate,
    })
    .from(assignments)
    .innerJoin(childProfiles, eq(childProfiles.id, assignments.childId))
    .where(eq(assignments.active, true))
    .orderBy(asc(childProfiles.createdAt), asc(childProfiles.id));
  const assignedByDeck = new Map<string, DeckAssignedChildDto[]>();
  for (const row of assignmentRows) {
    const list = assignedByDeck.get(row.deckId) ?? [];
    list.push({ childId: row.childId, displayName: row.displayName, testDate: row.testDate });
    assignedByDeck.set(row.deckId, list);
  }

  return rows.map((row) => {
    const edit = editableByDeck.get(row.id);
    const representativeVersionId = row.publishedVersionId ?? edit?.id ?? null;
    return {
      deckId: row.id,
      title: row.title,
      kind: row.kind as "vocabulary" | "lesson",
      coverAssetId: row.coverAssetId,
      sessionTaskBudget: row.sessionTaskBudget,
      vocabularyFormat: edit?.vocabularyFormat ?? versionById.get(row.publishedVersionId ?? "")?.vocabularyFormat ?? "standard",
      state: deckStateOf(row, edit ? (edit.state as "draft" | "review") : null),
      editableVersionId: edit?.id ?? null,
      publishedVersionId: row.publishedVersionId ?? null,
      itemCount: representativeVersionId ? (countByVersion.get(representativeVersionId) ?? 0) : 0,
      assignedChildren: assignedByDeck.get(row.id) ?? [],
    };
  });
}

const UpsertAssignmentSchema = z.object({
  childId: z.uuid(),
  deckId: z.uuid(),
  testDate: z
    .string()
    .nullable()
    .refine((value) => value === null || isFamilyDate(value), {
      message: "testDate must be YYYY-MM-DD or null",
    }),
});

/**
 * Przypisanie (lub aktualizacja terminu) zestawu dziecku. Termin sprawdzianu
 * jest opcjonalny i należy do pary dziecko–zestaw: jedno zestaw, różne daty.
 * Archiwum wycofano z nowych sesji; nieopublikowany zestaw nie jest jeszcze
 * materiałem dziecka.
 */
export async function upsertAssignment(
  services: Services,
  childId: string,
  deckId: string,
  testDate: string | null,
  options: { testGoals?: AssignmentGoal[] | null; mockTestTaskCount?: number } = {},
): Promise<void> {
  const valid = UpsertAssignmentSchema.parse({ childId, deckId, testDate });
  const settings = AssignmentPutSchema.parse({ testDate, ...options });
  const configuration = {
    ...(settings.testGoals === undefined ? {} : { testGoals: settings.testGoals }),
    ...(settings.mockTestTaskCount === undefined ? {} : { mockTestTaskCount: settings.mockTestTaskCount }),
  };
  const deck = (
    await services.db.select().from(decks).where(eq(decks.id, valid.deckId))
  )[0];
  if (!deck) {
    throw new AppError("not_found");
  }
  if (deck.archivedAt) {
    throw new AppError("conflict");
  }
  if (!deck.publishedVersionId) {
    throw new AppError("validation", { message: "deck is not published" });
  }
  // Cel kartkówki musi pasować do rodzaju zestawu (zadanie 11): lekcja przyjmuje
  // tylko cel `lesson`, słówka tylko cele słówkowe. Mieszanie już wyklucza CHECK
  // `assignments_test_goals`, ale dopasowanie do rodzaju jest regułą aplikacji.
  if (settings.testGoals != null && settings.testGoals.length > 0) {
    const wantsLesson = settings.testGoals.includes("lesson");
    if (deck.kind === "lesson" && !wantsLesson) {
      throw new AppError("validation", { message: "lesson deck requires the 'lesson' test goal" });
    }
    if (deck.kind !== "lesson" && wantsLesson) {
      throw new AppError("validation", { message: "vocabulary deck cannot use the 'lesson' test goal" });
    }
  }
  try {
    await services.db
      .insert(assignments)
      .values({
        id: randomUUID(),
        childId: valid.childId,
        deckId: valid.deckId,
        testDate: valid.testDate,
        ...configuration,
        active: true,
      })
      .onConflictDoUpdate({
        target: [assignments.childId, assignments.deckId],
        set: { testDate: valid.testDate, active: true, ...configuration },
      });
  } catch (error) {
    // nieznany profil dziecka: FK zamiast mglistego błędu sterownika (drizzle
    // opakowuje błąd pg, kod ConstraintErrorCode siedzi w cause)
    const pgCode =
      (error as { code?: string }).code ??
      (error as { cause?: { code?: string } }).cause?.code;
    if (pgCode === "23503") {
      throw new AppError("not_found");
    }
    throw error;
  }
}

/** Wycofuje przypisanie z nowych sesji i zachowuje historię zakończonych sesji. */
export async function removeAssignment(services: Services, childId: string, deckId: string): Promise<void> {
  const cId = z.uuid().parse(childId);
  const dId = z.uuid().parse(deckId);
  const existing = (await services.db.select({ id: assignments.id, active: assignments.active })
    .from(assignments).where(and(eq(assignments.childId, cId), eq(assignments.deckId, dId))))[0];
  if (!existing || !existing.active) throw new AppError("not_found");
  const sessionCount = (await services.db.select({ count: sql<number>`count(*)::int` }).from(learningSessions)
    .where(eq(learningSessions.assignmentId, existing.id)))[0]?.count ?? 0;
  if (sessionCount === 0) await services.db.delete(assignments).where(eq(assignments.id, existing.id));
  else await services.db.update(assignments).set({ active: false }).where(eq(assignments.id, existing.id));
}

/** Wycofanie zestawu z nowych sesji; idempotentne, historia zostaje. */
export async function archiveDeck(services: Services, deckId: string): Promise<void> {
  const id = z.uuid().parse(deckId);
  const deck = (await services.db.select().from(decks).where(eq(decks.id, id)))[0];
  if (!deck) {
    throw new AppError("not_found");
  }
  if (deck.archivedAt === null) {
    await services.db
      .update(decks)
      .set({ archivedAt: services.clock.now() })
      .where(eq(decks.id, id));
  }
}

/**
 * PATCH /parent/decks/:id — budżet zadań ocenianych sesji nauki zestawu
 * (`decks.session_task_budget`, 1–100). Konfiguracja runtime jak
 * `assignments`: mutacja bezpośrednia, bez nowego szkicu wersji; obowiązuje
 * słówka i lekcje. Start sesji przypina własną kopię w
 * `learning_sessions.task_budget`, więc zmiana nie dotyka trwających sesji.
 */
export async function updateDeckSettings(
  services: Services,
  deckId: string,
  settings: DeckSettingsPatch,
): Promise<DeckSettingsPatch> {
  const id = z.uuid().parse(deckId);
  const deck = (await services.db.select().from(decks).where(eq(decks.id, id)))[0];
  if (!deck) {
    throw new AppError("not_found");
  }
  if (deck.archivedAt) {
    throw new AppError("conflict");
  }
  await services.db
    .update(decks)
    .set({ sessionTaskBudget: settings.sessionTaskBudget })
    .where(eq(decks.id, id));
  return { sessionTaskBudget: settings.sessionTaskBudget };
}
