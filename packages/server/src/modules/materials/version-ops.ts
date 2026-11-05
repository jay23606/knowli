import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Tx } from "../../db/client";
import { deckVersions, decks } from "../../db/schema";
import { AppError } from "../../errors";

/**
 * Wspólne, subject-agnostyczne kroki edycji i wersjonowania wersji zestawu
 * (deck_versions), współdzielone przez zestawy słówek (`decks.ts`) i lekcje
 * (`modules/lessons/lesson-api.ts`). Tu żyją TYLKO mechaniki niezależne od
 * rodzaju zestawu: blokada wiersza wersji, optimistic locking (`editNumber`),
 * bufor edycji i szkielet „nowy szkic z opublikowanej wersji”. Logika zależna
 * od rodzaju (zapis elementów, walidacja, pokrycie, uzgodnienie mediów) jest
 * wstrzykiwana przez wywołującego i nie trafia tutaj — jedna kopia reguł
 * współdzielonych zamiast dwóch rozjeżdżających się implementacji.
 */

/** Blokuje wiersz wersji `FOR UPDATE`; brak wersji → `not_found`. */
export async function lockVersion(tx: Tx, versionId: string) {
  const rows = await tx.select().from(deckVersions).where(eq(deckVersions.id, versionId)).for("update");
  const version = rows[0];
  if (!version) {
    throw new AppError("not_found");
  }
  return version;
}

/**
 * Strażnik edycji szkicu: opublikowana wersja jest niezmienna (`immutable`),
 * a rozjechany `expectedEditNumber` to konflikt optymistycznego blokowania
 * (`conflict`). Wspólny dla edycji i publikacji obu rodzajów zestawów.
 */
export function assertEditable(
  version: { state: string; editNumber: number },
  expectedEditNumber: number,
): void {
  if (version.state === "published") {
    throw new AppError("immutable");
  }
  if (version.editNumber !== expectedEditNumber) {
    throw new AppError("conflict");
  }
}

/** Inkrement numeru edycji szkicu (optimistic locking). */
export async function bumpEditNumber(tx: Tx, versionId: string): Promise<void> {
  await tx
    .update(deckVersions)
    .set({ editNumber: sql`${deckVersions.editNumber} + 1` })
    .where(eq(deckVersions.id, versionId));
}

/** Minimalny opis wersji źródłowej przekazywany do kopiowania treści. */
export interface SourceVersion {
  id: string;
  deckId: string;
  title: string;
  sourceLocale: string;
  targetLocale: string;
  vocabularyFormat: "standard" | "picture";
  lessonContext: Record<string, unknown> | null;
}

/** Kopia `lesson_context` bez dawnego raportu krytyka (`review`) i bez luk generowania agentem (pozostałe pola bez zmian). */
function withoutRunReports(context: Record<string, unknown> | null | undefined): Record<string, unknown> | null | undefined {
  if (!context || (!("review" in context) && !("generationGaps" in context))) return context;
  const { review: _review, generationGaps: _generationGaps, ...rest } = context;
  return rest;
}

/**
 * Szkielet „nowy edytowalny szkic z bieżącej opublikowanej wersji”
 * (architecture.md §12: `POST /…/:id/draft`): blokada wiersza zestawu (serializuje
 * równoległe forki, strażnikiem ostatecznym jest indeks `one_editable_version_per_deck`),
 * strażniki archiwum/braku publikacji/istniejącego szkicu, policzenie kolejnego
 * `version_number` i wstawienie nowej wersji `draft` kopiującej tytuł, locale i
 * (dla lekcji) `lesson_context`. Kopię TREŚCI (rewizje, klucze umiejętności,
 * decyzje o mediach) wykonuje `copyContent`, wstrzyknięty przez rodzaj zestawu —
 * ta funkcja nie wie, czy kopiuje słówka czy ćwiczenia lekcji. Zwraca id nowej
 * wersji; wywołujący odczytuje właściwe DTO.
 */
export async function createVersionFromPublished(
  tx: Tx,
  deckId: string,
  copyContent: (tx: Tx, args: { source: SourceVersion; newVersionId: string }) => Promise<void>,
): Promise<string> {
  const deck = (await tx.select().from(decks).where(eq(decks.id, deckId)).for("update"))[0];
  if (!deck) {
    throw new AppError("not_found");
  }
  if (deck.archivedAt) {
    throw new AppError("conflict");
  }
  if (!deck.publishedVersionId) {
    throw new AppError("validation", { message: "deck is not published" });
  }
  const editable = (
    await tx
      .select({ id: deckVersions.id })
      .from(deckVersions)
      .where(and(eq(deckVersions.deckId, deckId), inArray(deckVersions.state, ["draft", "review"])))
  )[0];
  if (editable) {
    throw new AppError("conflict");
  }
  const source = (
    await tx.select().from(deckVersions).where(eq(deckVersions.id, deck.publishedVersionId))
  )[0]!;
  const maxVersion = (
    await tx
      .select({ max: sql<number>`max(${deckVersions.versionNumber})::int` })
      .from(deckVersions)
      .where(eq(deckVersions.deckId, deckId))
  )[0]!;

  // Dawny raport krytyka (`review`) i luki generowania agentem (`generationGaps`) dotyczą przebiegów
  // generowania tamtej wersji — nowa wersja ich nie dziedziczy.
  const lessonContext = withoutRunReports(source.lessonContext);
  const newVersionId = randomUUID();
  await tx.insert(deckVersions).values({
    id: newVersionId,
    deckId,
    versionNumber: maxVersion.max + 1,
    editNumber: 1,
    state: "draft",
    title: source.title,
    sourceLocale: source.sourceLocale,
    targetLocale: source.targetLocale,
    vocabularyFormat: source.vocabularyFormat,
    ...(lessonContext ? { lessonContext } : {}),
  });

  await copyContent(tx, {
    source: {
      id: source.id,
      deckId: source.deckId,
      title: source.title,
      sourceLocale: source.sourceLocale,
      targetLocale: source.targetLocale,
      vocabularyFormat: source.vocabularyFormat,
      lessonContext: lessonContext ?? null,
    },
    newVersionId,
  });

  return newVersionId;
}
