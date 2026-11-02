import { randomUUID } from "node:crypto";
import { asc, eq, sql } from "drizzle-orm";
import {
  ChildInputSchema,
  ChildPatchSchema,
  toChildDto,
  UuidSchema,
  type ChildDto,
  type ChildInput,
  type ChildPatch,
} from "@learning/contracts";
import { childProfiles, familySettings } from "../../db/schema";
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
    // Blokada wiersza profilu: równoległe inserty kosztów z kluczem obcym czekają
    // na KEY SHARE, a po commicie dostają 23503 i zapisują się bez przypisania —
    // żaden wiersz kosztu nie ominie zgrubienia.
    const locked = await tx.execute(sql`select id from learning_app.child_profiles where id = ${id} for update`);
    if (locked.rows.length === 0) {
      throw new AppError("not_found");
    }
    const timezoneRow = (await tx.select({ timezone: familySettings.timezone }).from(familySettings).limit(1))[0];
    await anonymizeChildUsage(tx, id, timezoneRow?.timezone ?? DEFAULT_TIMEZONE);
    await tx.delete(childProfiles).where(eq(childProfiles.id, id));
  });
}
