import { randomUUID } from "node:crypto";
import { and, eq, inArray, ne } from "drizzle-orm";
import { z } from "zod";
import {
  GenerationCommandSchema,
  MAX_DECK_ITEMS,
  type GenerationCommand,
  type GenerationDto,
  type VocabularyItemInput,
  type VocabularyFormat,
  isVisualDataValid,
} from "@learning/contracts";
import type { Services } from "../../config";
import type { Tx } from "../../db/client";
import type { LlmGenerateDeckInput } from "../../ports/ai";
import {
  claimQueuedRun,
  enqueueGenerationRun,
  isStoryRunInput,
  lessonStoryRunFilter,
  markRun,
  markRunSucceeded,
  markRunWithoutSourceItems,
  supersedeLessonRuns,
} from "./generation-runs";
import { deckVersions, decks, generationRuns, mediaAssets } from "../../db/schema";
import { AppError } from "../../errors";
import { applyItems } from "./decks";
import { committedRetryAfterSourceChange, lockSourceMaterialForCopy } from "./source-materials";
import { validateItems } from "./item-payload";
import { validateVocabularyFormatItems } from "../../domain/picture-vocabulary";
import {
  isMaterialVocabularyTarget,
  materialPhraseIndex,
  materialTargetMatchKey,
  materialTargetText,
} from "../../domain/lessons/subjects/english/material-phrase";
import { normalizeTargetText } from "../../domain/target-key";
import { reconcileDraftAssetsTx } from "./media-reconciliation";
import { executeMediaAsset } from "./media-generation";
import { errorCodeOf, MAX_AUTOMATIC_ATTEMPTS, requireGeneration } from "./generation-runtime";

const GeneratedItemSchema = z.object({
  source: z.string().min(1).max(120),
  target: z.string().min(1).max(120),
  acceptedAnswers: z.array(z.string().min(1).max(120)).max(20).default([]),
  example: z.string().min(1).max(300).optional(),
  visualType: z.enum(["image", "color", "number", "sequence", "none"]).default("none"),
  visualData: z.record(z.string(), z.unknown()).optional(),
}).refine((item) => isVisualDataValid(item.visualType, item.visualData, item.target), {
  path: ["visualData"],
  message: "visualData does not match visualType",
});
const GeneratedDeckSchema = z.object({
  items: z.array(GeneratedItemSchema).max(MAX_DECK_ITEMS),
});
/**
 * Górna granica długości listy modelu w trybie ze źródła: trzykrotny limit
 * zestawu zostawia miejsce na pozycje odrzucone (spoza tekstu, duplikaty), a
 * dłuższa lista to wynik zbiegły, którego prompt nie zamawia — porażka walidacji
 * jak przekroczenie `MAX_DECK_ITEMS` w trybie opisu. Ogranicza też pracę
 * `selectMaterialItems` (każdy element sprawdza duplikat wśród przyjętych).
 */
const MAX_MATERIAL_ENVELOPE_ITEMS = MAX_DECK_ITEMS * 3;
/**
 * Wynik modelu w trybie ze źródła: tylko kształt listy — każdy element
 * waliduje osobno `selectMaterialItems`, więc zły element nie psuje reszty.
 */
const GeneratedMaterialDeckSchema = z.object({
  items: z.array(z.unknown()).max(MAX_MATERIAL_ENVELOPE_ITEMS),
});

/** Domyślna para języków zestawu słówek; w trybie ze źródła jedyna dozwolona. */
const DEFAULT_DECK_LOCALES = { source: "pl-PL", target: "en-GB" } as const;
/** Domyślna maksymalna liczba pozycji, gdy polecenie jej nie podaje. */
const DEFAULT_GENERATION_MAX_ITEMS = 50;

/**
 * Niezmienny input runu `deck` (`generation_runs.input`). Tryb „z opisu” ma
 * `prompt` i nie ma `mode` (kształt sprzed Etapu 4). Tryb ze źródła
 * (design 2026-10-30 §6.2) ma `mode: "material"`, KOPIĘ tekstu źródła
 * w `material` i opcjonalne zawężenie `instruction` — bez `prompt`; worker nie
 * czyta już źródła, więc jego późniejsza edycja ani usunięcie nie zmienia runu.
 */
type DeckRunCommon = {
  deckId: string;
  deckVersionId: string;
  locales: { source: string; target: string };
  maxItems: number;
  vocabularyFormat: VocabularyFormat;
};
type DeckRunWords =
  | { prompt: string; mode?: undefined }
  | { mode: "material"; material: string; instruction?: string };
type DeckRunInput = DeckRunCommon & DeckRunWords;
/** Odczyt inputu runu: runy z opisu sprzed formatów słówek nie mają `vocabularyFormat` (standard). */
type StoredDeckRunInput = Omit<DeckRunCommon, "vocabularyFormat"> & { vocabularyFormat?: VocabularyFormat } & DeckRunWords;

type ParsedGenerationCommand = z.output<typeof GenerationCommandSchema>;

/** Skąd słowa zestawu: opis rodzica albo zapisane źródło z rewizją treści z podglądu. */
type DeckWordSource =
  | { kind: "prompt"; prompt: string }
  | { kind: "source"; sourceMaterialId: string; expectedBodyRevision: number; instruction?: string };

/**
 * Tryb polecenia po walidacji schematu (dokładnie jedno z `prompt` /
 * `sourceMaterialId`, rewizja tylko przy źródle). Zawężenie jest przycinane;
 * same białe znaki znaczą brak zawężenia (schemat przyjmuje je jako niepusty tekst).
 */
function deckWordSourceOf(cmd: ParsedGenerationCommand): DeckWordSource {
  if (cmd.sourceMaterialId !== undefined && cmd.expectedSourceRevision !== undefined && cmd.prompt === undefined) {
    const instruction = cmd.instruction?.trim();
    return {
      kind: "source",
      sourceMaterialId: cmd.sourceMaterialId,
      expectedBodyRevision: cmd.expectedSourceRevision,
      ...(instruction ? { instruction } : {}),
    };
  }
  if (cmd.prompt !== undefined && cmd.sourceMaterialId === undefined) {
    return { kind: "prompt", prompt: cmd.prompt };
  }
  // Nieosiągalne po `GenerationCommandSchema.parse` — obrona przed rozjazdem z kontraktem.
  throw new AppError("validation", { message: "provide exactly one of prompt or sourceMaterialId" });
}

/**
 * Zleca generowanie nowego zestawu słówek (deck + szkic + run `deck`)
 * idempotentnie po `idempotencyKey` — ponowienie zwraca pierwszy run, także
 * z innym ciałem (bez skrótu żądania, jak dotąd).
 *
 * Z opisu (`prompt`): tytuł z początku opisu, para języków z polecenia albo
 * domyślna, `generation_prompt` = opis.
 *
 * Ze źródła (`sourceMaterialId`, design 2026-10-30 §6.2): pierwsze zapytanie
 * transakcji tworzenia blokuje źródło `FOR KEY SHARE` (`lockSourceMaterialForCopy`)
 * i kopiuje jego tekst do inputu runu, a `decks.source_material_id/_revision`
 * zapisują pochodzenie (rewizja TREŚCI). Tytuł = podany (przycięty; same białe
 * znaki znaczą brak tytułu) albo tytuł źródła z tej samej wersji wiersza; para
 * języków stała `pl-PL` → `en-GB`;
 * `generation_prompt` = null (opisu nie ma). Brak źródła → `not_found`; rewizja
 * treści inna niż `expectedSourceRevision` → `conflict` z
 * `LessonSourceChangedDetails`, bez zapisu. Ponowienie tego samego klucza po
 * edycji albo usunięciu źródła zwraca zestaw pierwszego żądania — zarówno gdy
 * run już był widoczny (`enqueueGenerationRun`), jak i gdy pierwsze żądanie
 * zatwierdziło go w trakcie naszego (`committedRetryAfterSourceChange`).
 */
export async function enqueueDeckGeneration(
  services: Services,
  input: GenerationCommand,
): Promise<{ runId: string; deckId: string }> {
  const cmd = GenerationCommandSchema.parse(input);
  const wordSource = deckWordSourceOf(cmd);
  const dedupeKey = `deck:${cmd.idempotencyKey}`;
  const maxItems = cmd.maxItems ?? DEFAULT_GENERATION_MAX_ITEMS;

  if (wordSource.kind === "source") {
    return enqueueGenerationRun(services.db, dedupeKey, async (tx) => {
      // Pierwsze zapytanie transakcji: blokada źródła poprzedza każdy zapis zestawu.
      const source = await lockSourceMaterialForCopy(tx, wordSource.sourceMaterialId, wordSource.expectedBodyRevision);
      const ids = { deckId: randomUUID(), versionId: randomUUID(), runId: randomUUID() };
      const locales = DEFAULT_DECK_LOCALES;
      await insertGenerationDraft(tx, {
        ...ids,
        title: cmd.title?.trim() || source.title,
        origin: { sourceMaterialId: wordSource.sourceMaterialId, sourceMaterialRevision: source.bodyRevision },
        locales,
        vocabularyFormat: cmd.vocabularyFormat,
        generationPrompt: null,
        dedupeKey,
        input: {
          mode: "material",
          material: source.body,
          ...(wordSource.instruction === undefined ? {} : { instruction: wordSource.instruction }),
          deckId: ids.deckId,
          deckVersionId: ids.versionId,
          locales,
          maxItems,
          vocabularyFormat: cmd.vocabularyFormat,
        },
      });
      return { runId: ids.runId, deckId: ids.deckId };
    }).catch((error: unknown) => committedRetryAfterSourceChange(services.db, dedupeKey, error));
  }

  const { prompt } = wordSource;
  const locales = cmd.locales ?? DEFAULT_DECK_LOCALES;
  return enqueueGenerationRun(services.db, dedupeKey, async (tx) => {
    const ids = { deckId: randomUUID(), versionId: randomUUID(), runId: randomUUID() };
    await insertGenerationDraft(tx, {
      ...ids,
      title: cmd.title ?? prompt.slice(0, 60),
      origin: undefined,
      locales,
      vocabularyFormat: cmd.vocabularyFormat,
      generationPrompt: prompt,
      dedupeKey,
      input: {
        prompt,
        deckId: ids.deckId,
        deckVersionId: ids.versionId,
        locales,
        maxItems,
        vocabularyFormat: cmd.vocabularyFormat,
      },
    });
    return { runId: ids.runId, deckId: ids.deckId };
  });
}

/** Deck słówek + pierwszy szkic (edycja 1) + run `deck` w kolejce — wspólne dla obu trybów. */
async function insertGenerationDraft(
  tx: Tx,
  draft: {
    deckId: string;
    versionId: string;
    runId: string;
    title: string;
    origin: { sourceMaterialId: string; sourceMaterialRevision: number } | undefined;
    locales: { source: string; target: string };
    vocabularyFormat: VocabularyFormat;
    generationPrompt: string | null;
    dedupeKey: string;
    input: DeckRunInput;
  },
): Promise<void> {
  await tx.insert(decks).values({ id: draft.deckId, title: draft.title, ...draft.origin });
  await tx.insert(deckVersions).values({
    id: draft.versionId,
    deckId: draft.deckId,
    versionNumber: 1,
    editNumber: 1,
    state: "draft",
    title: draft.title,
    sourceLocale: draft.locales.source,
    targetLocale: draft.locales.target,
    vocabularyFormat: draft.vocabularyFormat,
    generationPrompt: draft.generationPrompt,
  });
  await tx.insert(generationRuns).values({
    id: draft.runId,
    deckVersionId: draft.versionId,
    expectedEditNumber: 1,
    kind: "deck",
    dedupeKey: draft.dedupeKey,
    state: "queued",
    input: draft.input,
  });
}

export async function readGeneration(services: Services, runId: string): Promise<GenerationDto> {
  const run = (await services.db.select().from(generationRuns).where(eq(generationRuns.id, runId)))[0];
  if (!run) {
    throw new AppError("not_found");
  }
  let deckId: string | null = null;
  if (run.deckVersionId) {
    deckId =
      (
        await services.db
          .select({ deckId: deckVersions.deckId })
          .from(deckVersions)
          .where(eq(deckVersions.id, run.deckVersionId))
      )[0]?.deckId ?? null;
  }
  return {
    id: run.id,
    deckId,
    deckVersionId: run.deckVersionId ?? null,
    state: run.state as GenerationDto["state"],
    attempts: run.attempts,
    errorCode: run.errorCode ?? null,
    rejectedCount: run.rejectedCount ?? null,
  };
}

/**
 * Ręczne ponowienie po porażce (lub odblokowanie runu utkwionego w running
 * po awarii workera). Resetuje budżet prób; nie rusza runów zakończonych.
 * Zwraca id runu do śledzenia: zwykle ten sam, a dla runu historyjki
 * w `running` — id nowego runu, który go zastępuje.
 */
export async function retryGeneration(services: Services, runId: string): Promise<{ runId: string }> {
  const run = (await services.db.select().from(generationRuns).where(eq(generationRuns.id, runId)))[0];
  if (!run) {
    throw new AppError("not_found");
  }
  if (run.state === "succeeded" || run.state === "superseded") {
    throw new AppError("conflict");
  }
  return services.db.transaction(async (tx): Promise<{ runId: string }> => {
    if (run.kind === "lesson") {
      // Taka sama kolejność blokad jak finalizacja lekcji: wersja, potem run.
      const version = (await tx.select().from(deckVersions).where(eq(deckVersions.id, run.deckVersionId!)).for("update"))[0];
      const current = (await tx.select().from(generationRuns).where(eq(generationRuns.id, runId)).for("update"))[0];
      if (!version || !current || version.state === "published" || current.state === "succeeded" || current.state === "superseded") throw new AppError("conflict");
      if (isStoryRunInput(current.input)) {
        // Run historyjki nie zależy od numeru edycji (spec §6.2): ponawiamy go
        // z bieżącym numerem, bez podbijania go i bez anulowania innych runów.
        const deferred = current.state === "queued" && current.nextAttemptAt !== null && current.nextAttemptAt > services.clock.now();
        if (current.state === "queued" && !deferred) return { runId };
        // Jeden aktywny run historyjki na wersję.
        const otherActive = (await tx.select({ id: generationRuns.id }).from(generationRuns).where(and(
          eq(generationRuns.kind, "lesson"),
          eq(generationRuns.deckVersionId, version.id),
          inArray(generationRuns.state, ["queued", "running"]),
          ne(generationRuns.id, runId),
          lessonStoryRunFilter(),
        )).limit(1))[0];
        if (otherActive) throw new AppError("conflict");
        if (current.state === "running") {
          // `running` (np. po awarii workera): stary run zostaje `superseded`,
          // a jego miejsce zajmuje NOWY run z pełnym budżetem prób i tym samym
          // wejściem (spec §6.2a). Spóźniony worker starego runu nie przejdzie
          // CAS finalizacji (`running` + próba), więc nie nadpisze wyniku.
          await tx.update(generationRuns)
            .set({ state: "superseded", errorCode: null, nextAttemptAt: null, finishedAt: services.clock.now() })
            .where(eq(generationRuns.id, runId));
          const newRunId = randomUUID();
          await tx.insert(generationRuns).values({
            id: newRunId,
            deckVersionId: version.id,
            expectedEditNumber: version.editNumber,
            kind: "lesson",
            dedupeKey: `lesson-story:retry:${newRunId}`,
            state: "queued",
            input: current.input,
          });
          return { runId: newRunId };
        }
        // Porażka i odroczone queued dostają nowy budżet prób.
        await tx.update(generationRuns)
          .set({
            state: "queued",
            attempts: 0,
            errorCode: null,
            finishedAt: null,
            nextAttemptAt: null,
            expectedEditNumber: version.editNumber,
          })
          .where(eq(generationRuns.id, runId));
        return { runId };
      }
      if (current.state === "queued") {
        if (current.nextAttemptAt && current.nextAttemptAt > services.clock.now()) {
          await tx.update(generationRuns).set({ attempts: 0, errorCode: null, nextAttemptAt: null })
            .where(eq(generationRuns.id, runId));
        }
        return { runId };
      }
      if (version.editNumber !== current.expectedEditNumber) throw new AppError("conflict");
      const editNumber = version.editNumber + 1;
      await tx.update(deckVersions).set({ editNumber }).where(eq(deckVersions.id, version.id));
      // Ponowiony pełny run lekcji to nowa pula (spec §6.2): run historyjki
      // w toku byłby walidowany wobec starej puli, więc też go anulujemy.
      // Ponowione dogenerowanie celu historyjki nie anuluje.
      const isTopUp = (current.input as { regenerate?: unknown } | null)?.regenerate !== undefined;
      await supersedeLessonRuns(tx, version.id, services.clock.now(), runId, { includeStoryRuns: !isTopUp });
      await tx.update(generationRuns).set({ state: "queued", attempts: 0, errorCode: null, finishedAt: null, nextAttemptAt: null, expectedEditNumber: editNumber }).where(eq(generationRuns.id, runId));
      return { runId };
    }
    if (run.assetId) {
      const asset = (await tx.select().from(mediaAssets).where(eq(mediaAssets.id, run.assetId)))[0];
      if (asset?.state === "ready") {
        throw new AppError("conflict");
      }
      if (asset && asset.state === "failed") {
        await tx
          .update(mediaAssets)
          .set({ state: "pending", leaseToken: null, leaseUntil: null })
          .where(eq(mediaAssets.id, asset.id));
      }
    }
    // liczba odrzuceń należy do zakończonej próby (porażka `no_source_items`); nowa próba zapisze własną
    await tx
      .update(generationRuns)
      .set({ state: "queued", attempts: 0, errorCode: null, finishedAt: null, rejectedCount: null })
      .where(eq(generationRuns.id, runId));
    return { runId };
  });
}

export async function executeGeneration(services: Services, runId: string, signal?: AbortSignal): Promise<void> {
  const deps = requireGeneration(services);
  const run = (await services.db.select().from(generationRuns).where(eq(generationRuns.id, runId)))[0];
  if (!run) {
    throw new AppError("not_found");
  }
  if (run.kind !== "deck") {
    if (run.kind === "lesson") {
      // Runy lekcji wykonuje dedykowany moduł (modules/lessons/lesson-drafts.ts);
      // generation-worker rozdziela je w runDueGenerationWork, więc tu nie powinny trafić.
      throw new AppError("internal", { message: "lesson run must be executed by lesson module" });
    }
    await executeMediaAsset(services, run.assetId!, signal);
    return;
  }
  if (run.state !== "queued") {
    return;
  }
  if (signal?.aborted) return;

  const attempts = await claimQueuedRun(services.db, runId);
  if (attempts === null) {
    return;
  }
  if (attempts > MAX_AUTOMATIC_ATTEMPTS) {
    await markRun(services.db, services.clock, runId, "failed", "attempts_exhausted");
    return;
  }

  const runInput = run.input as StoredDeckRunInput;
  const vocabularyFormat = runInput.vocabularyFormat ?? "standard";
  const llmInput: LlmGenerateDeckInput = runInput.mode === "material"
    ? {
      material: runInput.material,
      ...(runInput.instruction === undefined ? {} : { instruction: runInput.instruction }),
      sourceLocale: runInput.locales.source,
      targetLocale: runInput.locales.target,
      maxItems: runInput.maxItems,
      vocabularyFormat,
    }
    : {
      prompt: runInput.prompt,
      sourceLocale: runInput.locales.source,
      targetLocale: runInput.locales.target,
      maxItems: runInput.maxItems,
      vocabularyFormat,
    };
  let generated:
    | { mode: "description"; items: z.infer<typeof GeneratedDeckSchema>["items"] }
    | { mode: "material"; material: string; items: unknown[] };
  try {
    const result = await deps.llm.generateDeck(llmInput, signal);
    // tryb opisu: cały wynik pod schematem (wszystko-albo-nic); tryb ze źródła: sama lista
    generated = runInput.mode === "material"
      ? { mode: "material", material: runInput.material, items: GeneratedMaterialDeckSchema.parse(result).items }
      : { mode: "description", items: GeneratedDeckSchema.parse(result).items };
  } catch (error) {
    if (signal?.aborted) {
      await markRun(services.db, services.clock, runId, "queued", null);
      return;
    }
    const code = errorCodeOf(error);
    if (code === "validation") {
      await markRun(services.db, services.clock, runId, "failed", "validation");
    } else if (attempts >= MAX_AUTOMATIC_ATTEMPTS) {
      await markRun(services.db, services.clock, runId, "failed", "attempts_exhausted");
    } else {
      await markRun(services.db, services.clock, runId, "queued", null);
    }
    return;
  }

  if (signal?.aborted) {
    await markRun(services.db, services.clock, runId, "queued", null);
    return;
  }

  let items: VocabularyItemInput[];
  let rejectedCount: number | null;
  if (generated.mode === "material") {
    const selection = selectMaterialItems(generated.items, {
      material: generated.material,
      locales: runInput.locales,
      vocabularyFormat,
      maxItems: runInput.maxItems,
    });
    if (selection.items.length === 0) {
      // szkic bez zmian; liczba odrzuceń widoczna przy porażce
      await markRunWithoutSourceItems(services.db, services.clock, runId, selection.rejectedCount);
      return;
    }
    ({ items, rejectedCount } = selection);
  } else {
    if (generated.items.length === 0) {
      await markRun(services.db, services.clock, runId, "failed", vocabularyFormat === "picture" ? "no_picture_material" : "validation");
      return;
    }
    items = generated.items.map((item) => toVocabularyItem(item, runInput.locales));
    try {
      validateItems(items);
      validateVocabularyFormatItems(vocabularyFormat, items);
    } catch (error) {
      if (error instanceof AppError && error.code === "validation") {
        await markRun(services.db, services.clock, runId, "failed", "validation");
        return;
      }
      throw error;
    }
    // tryb opisu: walidacja wszystko-albo-nic, więc bez liczby odrzuceń
    rejectedCount = null;
  }

  await services.db.transaction(async (tx) => {
    const version = (
      await tx.select().from(deckVersions).where(eq(deckVersions.id, run.deckVersionId!)).for("update")
    )[0];
    if (!version) {
      await markRun(tx, services.clock, runId, "failed", "deck_version_gone");
      return;
    }
    // wynik zapisujemy tylko przy zgodnym numerze edycji szkicu
    if (version.state === "published" || version.editNumber !== run.expectedEditNumber) {
      await markRun(tx, services.clock, runId, "superseded", null);
      return;
    }
    await applyItems(tx, version.id, version.deckId, items);
    await reconcileDraftAssetsTx(tx, services, version);
    await tx.update(deckVersions).set({ state: "review" }).where(eq(deckVersions.id, version.id));
    await markRunSucceeded(tx, services.clock, runId, rejectedCount);
  });
}

type GeneratedItem = z.infer<typeof GeneratedItemSchema>;

function toVocabularyItem(item: GeneratedItem, locales: { source: string; target: string }): VocabularyItemInput {
  return {
    source: item.source,
    target: item.target,
    acceptedAnswers: item.acceptedAnswers,
    ...(item.example === undefined ? {} : { example: item.example }),
    visualType: item.visualType,
    ...(item.visualData === undefined ? {} : { visualData: item.visualData }),
    locales,
  };
}

/** Czy reguła zestawu (rzucająca `AppError("validation")`) przyjmuje element; inne błędy przechodzą dalej. */
function passesValidation(check: () => void): boolean {
  try {
    check();
    return true;
  } catch (error) {
    if (error instanceof AppError && error.code === "validation") return false;
    throw error;
  }
}

/**
 * Element zestawu ze źródła w zapisie do oceny (przegląd Etapu 4): cel i warianty
 * przez `materialTargetText` (bez końcowej interpunkcji, prosty apostrof); puste
 * warianty i powtórzenia celu albo wcześniejszego wariantu znikają. Przykład
 * i znaczenie zostają bez zmian.
 */
function toMaterialVocabularyItem(item: GeneratedItem, locales: { source: string; target: string }): VocabularyItemInput {
  const target = materialTargetText(item.target);
  const seen = new Set([normalizeTargetText(target)]);
  const acceptedAnswers: string[] = [];
  for (const answer of item.acceptedAnswers.map(materialTargetText)) {
    const key = normalizeTargetText(answer);
    if (answer === "" || seen.has(key)) continue;
    seen.add(key);
    acceptedAnswers.push(answer);
  }
  return toVocabularyItem({ ...item, target, acceptedAnswers }, locales);
}

/**
 * Walidacja per element zestawu ze źródła (design 2026-10-30 §6.2): każdy
 * element wyniku modelu osobno — schemat elementu, brak duplikatu po
 * dopasowaniu wśród już przyjętych (`materialTargetMatchKey`: „a coat” po
 * „coat”, „It's raining.” po „It's raining”; pierwszy wygrywa, odrzucony
 * element celu nie zajmuje), słówko z tekstu (`isMaterialVocabularyTarget` na
 * surowym celu: nie rama z luką, fraza z tekstu; słowa funkcyjne stojące
 * w tekście są dozwolone), reguły formatu i wizualizacji na zapisanym celu
 * (`validateVocabularyFormatItems`, `isVisualDataValid`) oraz reguły zestawu
 * (`validateItems`). Zapisany cel nie ma końcowej interpunkcji
 * (`toMaterialVocabularyItem`). Niepoprawny element jest odrzucany, reszta
 * zostaje. Po przyjęciu `maxItems` pozycji sprawdzanie się kończy: dalsze
 * elementy nie są ani przyjęte, ani liczone jako odrzucone. Gwarancja „tylko
 * słowa z tekstu” należy do tej walidacji, nie do promptu — zawężenie rodzica
 * nie może dodać słów.
 */
function selectMaterialItems(
  raw: readonly unknown[],
  options: { material: string; locales: { source: string; target: string }; vocabularyFormat: VocabularyFormat; maxItems: number },
): { items: VocabularyItemInput[]; rejectedCount: number } {
  const index = materialPhraseIndex(options.material);
  const accepted: VocabularyItemInput[] = [];
  const acceptedKeys = new Set<string>();
  let rejectedCount = 0;
  for (const candidate of raw) {
    if (accepted.length >= options.maxItems) break;
    const parsed = GeneratedItemSchema.safeParse(candidate);
    if (!parsed.success) {
      rejectedCount += 1;
      continue;
    }
    const item = toMaterialVocabularyItem(parsed.data, options.locales);
    const key = materialTargetMatchKey(item.target);
    if (
      acceptedKeys.has(key)
      || !isMaterialVocabularyTarget(parsed.data.target, index)
      || !isVisualDataValid(item.visualType, item.visualData, item.target)
      || !passesValidation(() => validateVocabularyFormatItems(options.vocabularyFormat, [item]))
      || !passesValidation(() => validateItems([...accepted, item]))
    ) {
      rejectedCount += 1;
      continue;
    }
    acceptedKeys.add(key);
    accepted.push(item);
  }
  return { items: accepted, rejectedCount };
}
