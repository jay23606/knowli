import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import {
  ChildInputSchema,
  ChildPatchSchema,
  toChildDto,
  UuidSchema,
  type ChildDto,
  type ChildInput,
  type ChildPatch,
} from "@learning/contracts";
import { childProfiles, familySettings, learningSessions } from "../../db/schema";
import { AppError } from "../../errors";
import type { Services } from "../../config";
import { anonymizeChildUsage } from "../../providers/usage/anonymize";

const DEFAULT_TIMEZONE = "Europe/Warsaw";

export async function listChildren(services: Services): Promise<ChildDto[]> {
  const rows = await services.db
    .select()
    .from(childProfiles)
    .orderBy(asc(childProfiles.createdAt), asc(childProfiles.id));
  return rows.map(toChildDto);
}

export async function createChild(services: Services, input: ChildInput): Promise<ChildDto> {
  const valid = ChildInputSchema.parse(input);
  const [row] = await services.db
    .insert(childProfiles)
    .values({
      id: randomUUID(),
      displayName: valid.displayName,
      avatarKey: valid.avatarKey,
      birthYear: valid.birthYear ?? null,
      canRead: valid.canRead,
    })
    .returning();
  return toChildDto(row!);
}

/** Zmienia dane wyświetlane, zachowując tożsamość i historię dziecka. */
export async function updateChild(services: Services, childId: string, input: ChildPatch): Promise<ChildDto> {
  const id = UuidSchema.parse(childId);
  const valid = ChildPatchSchema.parse(input);
  const [row] = await services.db.update(childProfiles).set({
    ...(valid.displayName !== undefined ? { displayName: valid.displayName } : {}),
    ...(valid.avatarKey !== undefined ? { avatarKey: valid.avatarKey } : {}),
    ...(valid.recordingMode !== undefined ? { recordingMode: valid.recordingMode } : {}),
    ...(valid.canRead !== undefined ? { canRead: valid.canRead } : {}),
    ...(valid.interests !== undefined ? { interests: valid.interests } : {}),
  }).where(eq(childProfiles.id, id)).returning();
  if (!row) throw new AppError("not_found");
  return toChildDto(row);
}

/**
 * Usunięcie profilu kasuje całą historię dziecka (sesje, próby, wydarzenia,
 * projekcje) przez CASCADE w bazie; wspólny materiał pozostaje.
 */
export async function deleteChild(services: Services, childId: string): Promise<void> {
  const id = UuidSchema.parse(childId);
  await services.db.transaction(async (tx) => {
    // Kolejność blokad jak w triggerach FK insertu kosztu (najpierw sesja, potem
    // profil), żeby równoległy zapis kosztu nie zakleszczył się z kaskadą usunięcia.
    // Wstawki, które zdążą przed blokadą, zgrubia UPDATE poniżej; te po niej
    // czekają na KEY SHARE, po commicie dostają 23503 i zapisują się bez
    // przypisania (recorder ponawia też po deadlocku 40P01).
    await tx.select({ id: learningSessions.id }).from(learningSessions)
      .where(eq(learningSessions.childId, id)).orderBy(learningSessions.id).for("update");
    const locked = await tx.select({ id: childProfiles.id }).from(childProfiles)
      .where(eq(childProfiles.id, id)).for("update");
    if (locked.length === 0) {
      throw new AppError("not_found");
    }
    const timezoneRow = (await tx.select({ timezone: familySettings.timezone }).from(familySettings).limit(1))[0];
    await anonymizeChildUsage(tx, id, timezoneRow?.timezone ?? DEFAULT_TIMEZONE);
    await tx.delete(childProfiles).where(eq(childProfiles.id, id));
  });
}
