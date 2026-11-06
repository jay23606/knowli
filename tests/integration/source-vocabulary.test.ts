import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createServices,
  createSourceMaterial,
  deleteSourceMaterial,
  enqueueDeckGeneration,
  executeGeneration,
  getSourceMaterial,
  readDeck,
  readGeneration,
  retryGeneration,
  updateSourceMaterial,
  type Services,
} from "@learning/server";
import type { GenerationCommand } from "@learning/contracts";
import { markRunSucceeded } from "../../packages/server/src/modules/materials/generation-runs";
import { matchWrittenAnswer } from "../../packages/server/src/domain/evaluate";
import type { AnswerKey } from "../../packages/server/src/domain/types";
import { fakeGeneration, type FakeGeneration, type LlmBehavior } from "./fakes";
import { buildTestServices, ManualClock, testDatabase } from "./helpers";

/**
 * Słówka ze źródła (design 2026-10-30 „Angielski — rozdział”, §6.2) na
 * PostgreSQL: tworzenie zestawu słówek z kopią tekstu zapisanego źródła
 * (pochodzenie w `decks`, tekst w niezmiennym inpucie runu), kontrola rewizji
 * treści z podglądu rodzica, idempotentne ponowienie po edycji i usunięciu
 * źródła, odnośnik `source` w `DeckDto` oraz liczba odrzuceń w runie
 * (`rejected_count`, `GenerationDto.rejectedCount`) oraz generowanie z tekstu:
 * worker z fałszywym LLM, walidacja per element (spoza tekstu, ramy, duplikaty,
 * format obrazkowy, limit) i porażka `no_source_items`; tryb opisu zostaje
 * wszystko-albo-nic. Teksty są fikcyjne — materiał z podręcznika nie trafia do
 * repozytorium.
 */

const { pool } = testDatabase();

afterAll(async () => {
  await pool.end();
});

async function query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await pool.query(sql, params)).rows as T[];
}

async function count(table: string): Promise<number> {
  const rows = await query<{ count: number }>(`select count(*)::int as count from learning_app.${table}`);
  return rows[0]!.count;
}

const CHAPTER_TEXT = [
  "What's the weather like? It's sunny. It's raining.",
  "I'm wearing a coat and boots. She is wearing a pink T-shirt.",
].join("\n");
const SOURCE_TITLE = "Rozdział 4: Pogoda i ubrania";
const SOURCE_CHANGED = { code: "conflict", details: { reason: "source_changed" } };

interface StoredVocabularyDeck {
  deck: { title: string; kind: string; source_material_id: string | null; source_material_revision: number | null };
  version: {
    id: string;
    title: string;
    state: string;
    source_locale: string;
    target_locale: string;
    vocabulary_format: string;
    generation_prompt: string | null;
    lesson_context: unknown;
  };
  run: { id: string; kind: string; state: string; dedupe_key: string; input: Record<string, unknown>; rejected_count: number | null };
}

async function storedVocabularyDeck(deckId: string): Promise<StoredVocabularyDeck> {
  const [deck] = await query<StoredVocabularyDeck["deck"]>(
    "select title, kind, source_material_id, source_material_revision from learning_app.decks where id = $1", [deckId],
  );
  const [version] = await query<StoredVocabularyDeck["version"]>(
    `select id, title, state, source_locale, target_locale, vocabulary_format, generation_prompt, lesson_context
       from learning_app.deck_versions where deck_id = $1`, [deckId],
  );
  const [run] = await query<StoredVocabularyDeck["run"]>(
    `select r.id, r.kind, r.state, r.dedupe_key, r.input, r.rejected_count from learning_app.generation_runs r
       join learning_app.deck_versions v on v.id = r.deck_version_id where v.deck_id = $1`, [deckId],
  );
  return { deck: deck!, version: version!, run: run! };
}

type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };
function settle<T>(promise: Promise<T>): Promise<Outcome<T>> {
  return promise.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
}

describe("słówka ze źródła — tworzenie zestawu (integracja)", () => {
  let services: Services;
  let clock: ManualClock;

  beforeEach(async () => {
    await pool.query("truncate learning_app.generation_runs, learning_app.decks, learning_app.source_materials cascade");
    ({ services, clock } = buildTestServices("2026-10-31T10:00:00.000Z"));
  });

  async function seedSource(body = CHAPTER_TEXT, title = SOURCE_TITLE): Promise<string> {
    return (await createSourceMaterial(services, { clientRequestId: randomUUID(), title, body })).id;
  }

  // `expectedSourceRevision` — rewizja treści z podglądu rodzica; świeże źródło ma 1.
  const sourceCommand = (sourceMaterialId: string, overrides: Partial<GenerationCommand> = {}): GenerationCommand => ({
    sourceMaterialId,
    expectedSourceRevision: 1,
    idempotencyKey: `source-vocabulary-${randomUUID()}`,
    ...overrides,
  });

  it("kopiuje bieżący tekst i rewizję treści źródła do zestawu i runu; tytuł z tytułu źródła", async () => {
    const sourceId = await seedSource();
    const body = `${CHAPTER_TEXT}\nIt's snowing.`;
    await updateSourceMaterial(services, sourceId, { expectedRevision: 1, body });

    // podgląd rodzica pokazał rewizję treści 2 — to ją serwer kopiuje
    const command = sourceCommand(sourceId, { expectedSourceRevision: 2, instruction: "tylko pogoda", maxItems: 20, vocabularyFormat: "picture" });
    const { runId, deckId } = await enqueueDeckGeneration(services, command);

    const stored = await storedVocabularyDeck(deckId);
    expect(stored.deck).toEqual({ title: SOURCE_TITLE, kind: "vocabulary", source_material_id: sourceId, source_material_revision: 2 });
    expect(stored.version).toMatchObject({
      title: SOURCE_TITLE,
      state: "draft",
      source_locale: "pl-PL",
      target_locale: "en-GB",
      vocabulary_format: "picture",
      generation_prompt: null,
      lesson_context: null,
    });
    expect(stored.run).toMatchObject({ id: runId, kind: "deck", state: "queued", dedupe_key: `deck:${command.idempotencyKey}`, rejected_count: null });
    // niezmienny input runu: kopia tekstu, bez `prompt`; para języków stała
    expect(stored.run.input).toEqual({
      mode: "material",
      material: body,
      instruction: "tylko pogoda",
      deckId,
      deckVersionId: stored.version.id,
      locales: { source: "pl-PL", target: "en-GB" },
      maxItems: 20,
      vocabularyFormat: "picture",
    });
    expect(await readGeneration(services, runId)).toEqual({
      id: runId,
      deckId,
      deckVersionId: stored.version.id,
      state: "queued",
      attempts: 0,
      errorCode: null,
      rejectedCount: null,
    });
  });

  it("podany tytuł wygrywa z tytułem źródła; domyślnie 50 pozycji i format standard", async () => {
    const sourceId = await seedSource();

    const { deckId } = await enqueueDeckGeneration(services, sourceCommand(sourceId, { title: "Pogoda — słówka" }));

    const stored = await storedVocabularyDeck(deckId);
    expect(stored.deck.title).toBe("Pogoda — słówka");
    expect(stored.version.title).toBe("Pogoda — słówka");
    expect(stored.version.vocabulary_format).toBe("standard");
    expect(stored.run.input).toMatchObject({ mode: "material", material: CHAPTER_TEXT, maxItems: 50, vocabularyFormat: "standard" });
    expect(stored.run.input).not.toHaveProperty("instruction");
    expect(stored.run.input).not.toHaveProperty("prompt");
  });

  it("tytuł z samych białych znaków daje tytuł źródła, a podany jest przycinany", async () => {
    const sourceId = await seedSource();

    const blank = await enqueueDeckGeneration(services, sourceCommand(sourceId, { title: " \n\t " }));
    const padded = await enqueueDeckGeneration(services, sourceCommand(sourceId, { title: "  Pogoda — słówka \n" }));

    expect((await storedVocabularyDeck(blank.deckId)).deck.title).toBe(SOURCE_TITLE);
    expect((await storedVocabularyDeck(blank.deckId)).version.title).toBe(SOURCE_TITLE);
    expect((await storedVocabularyDeck(padded.deckId)).deck.title).toBe("Pogoda — słówka");
    expect((await storedVocabularyDeck(padded.deckId)).version.title).toBe("Pogoda — słówka");
  });

  it("zawężenie jest przycinane, a samo białe znaki go nie dają", async () => {
    const sourceId = await seedSource();

    const trimmed = await enqueueDeckGeneration(services, sourceCommand(sourceId, { instruction: "  tylko pogoda \n" }));
    const blank = await enqueueDeckGeneration(services, sourceCommand(sourceId, { instruction: " \n\t " }));

    expect((await storedVocabularyDeck(trimmed.deckId)).run.input).toMatchObject({ instruction: "tylko pogoda" });
    expect((await storedVocabularyDeck(blank.deckId)).run.input).not.toHaveProperty("instruction");
  });

  it("podgląd sprzed zmiany tekstu źródła: konflikt source_changed i żadnego zapisu; rewizja z przyszłości też", async () => {
    const sourceId = await seedSource();
    await updateSourceMaterial(services, sourceId, { expectedRevision: 1, body: "Tekst zmieniony w innym oknie." });

    await expect(enqueueDeckGeneration(services, sourceCommand(sourceId))).rejects.toMatchObject(SOURCE_CHANGED);
    await expect(enqueueDeckGeneration(services, sourceCommand(sourceId, { expectedSourceRevision: 3 }))).rejects.toMatchObject(SOURCE_CHANGED);

    expect(await count("decks")).toBe(0);
    expect(await count("deck_versions")).toBe(0);
    expect(await count("generation_runs")).toBe(0);
  });

  it("zmiana samego tytułu źródła nie blokuje tworzenia, a zestaw dostaje nowy tytuł", async () => {
    const sourceId = await seedSource();
    await updateSourceMaterial(services, sourceId, { expectedRevision: 1, title: "Nowy tytuł rozdziału" });

    const { deckId } = await enqueueDeckGeneration(services, sourceCommand(sourceId));

    expect((await storedVocabularyDeck(deckId)).deck).toMatchObject({ title: "Nowy tytuł rozdziału", source_material_revision: 1 });
  });

  it("nieistniejące źródło kończy się not_found bez zapisu", async () => {
    await expect(enqueueDeckGeneration(services, sourceCommand(randomUUID()))).rejects.toMatchObject({ code: "not_found" });

    expect(await count("decks")).toBe(0);
    expect(await count("generation_runs")).toBe(0);
  });

  it("odrzuca polecenia łączące tryby albo nadpisujące parę języków, bez zapisu", async () => {
    const sourceId = await seedSource();

    await expect(enqueueDeckGeneration(services, sourceCommand(sourceId, { prompt: "pogoda" }))).rejects.toMatchObject({ name: "ZodError" });
    await expect(enqueueDeckGeneration(services, sourceCommand(sourceId, { locales: { source: "pl-PL", target: "de-DE" } })))
      .rejects.toMatchObject({ name: "ZodError" });
    await expect(enqueueDeckGeneration(services, sourceCommand(sourceId, { expectedSourceRevision: undefined })))
      .rejects.toMatchObject({ name: "ZodError" });
    await expect(enqueueDeckGeneration(services, { prompt: "pogoda", instruction: "tylko deszcz", idempotencyKey: "prompt-with-instruction" }))
      .rejects.toMatchObject({ name: "ZodError" });

    expect(await count("decks")).toBe(0);
    expect(await count("generation_runs")).toBe(0);
  });

  it("ponowienie z tym samym kluczem zwraca ten sam zestaw, także po edycji i usunięciu źródła", async () => {
    const sourceId = await seedSource();
    const request = sourceCommand(sourceId);

    const first = await enqueueDeckGeneration(services, request);
    await expect(enqueueDeckGeneration(services, request)).resolves.toEqual(first);
    // klucz idempotencji jest sprawdzany przed odczytem źródła: nowsza rewizja treści nie daje 409
    await updateSourceMaterial(services, sourceId, { expectedRevision: 1, body: "Tekst po utworzeniu zestawu." });
    await expect(enqueueDeckGeneration(services, request)).resolves.toEqual(first);
    expect((await storedVocabularyDeck(first.deckId)).run.input).toMatchObject({ material: CHAPTER_TEXT });
    await deleteSourceMaterial(services, sourceId);
    await expect(enqueueDeckGeneration(services, request)).resolves.toEqual(first);

    expect(await count("decks")).toBe(1);
    expect(await count("generation_runs")).toBe(1);
  });

  it("równoległe żądania z tym samym kluczem dają jeden zestaw", async () => {
    const sourceId = await seedSource();
    const request = sourceCommand(sourceId);

    const [a, b] = await Promise.all([enqueueDeckGeneration(services, request), enqueueDeckGeneration(services, request)]);

    expect(a).toEqual(b);
    expect(await count("decks")).toBe(1);
    expect(await count("generation_runs")).toBe(1);
  });

  // Niepewny zapis ponowiony po usunięciu lub edycji źródła (plan Etapu 4, Review Focus 4):
  // ponowienie zatrzymane między sprawdzeniem klucza idempotencji (jeszcze bez runu) a własną
  // transakcją; w tym czasie pierwsze żądanie zapisuje zestaw, a źródło znika albo dostaje nową
  // rewizję treści, zanim ponowienie je zablokuje — jego odczyt źródła kończy się not_found albo
  // konfliktem, a odpowiedzią jest zestaw pierwszego żądania.
  it.each([
    ["równoległym usunięciu", (sourceId: string) => deleteSourceMaterial(services, sourceId)],
    ["równoległej zmianie tekstu", async (sourceId: string) => {
      await updateSourceMaterial(services, sourceId, { expectedRevision: 1, body: "Tekst zmieniony po pierwszym żądaniu." });
    }],
  ] as const)("ponowienie po %s źródła zwraca zestaw zatwierdzony przez pierwsze żądanie", async (_label, changeSource) => {
    const sourceId = await seedSource();
    const request = sourceCommand(sourceId);
    let markWaiting!: () => void;
    const waiting = new Promise<void>((resolve) => { markWaiting = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const db = services.db;
    const gatedDb = new Proxy(db, {
      get(target, property) {
        if (property === "transaction") {
          return async (...args: unknown[]) => {
            markWaiting();
            await gate;
            return (target.transaction as (...transactionArgs: unknown[]) => Promise<unknown>).apply(target, args);
          };
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? (value as (...valueArgs: unknown[]) => unknown).bind(target) : value;
      },
    });
    let retry: Promise<Outcome<Awaited<ReturnType<typeof enqueueDeckGeneration>>>> | undefined;
    try {
      retry = settle(enqueueDeckGeneration({ ...services, db: gatedDb }, request));
      await waiting;
      const first = await enqueueDeckGeneration(services, request);
      await changeSource(sourceId);
      release();

      expect(await retry).toEqual({ ok: true, value: first });
      expect(await count("decks")).toBe(1);
      expect(await count("generation_runs")).toBe(1);
      expect((await storedVocabularyDeck(first.deckId)).run.input).toMatchObject({ material: CHAPTER_TEXT });
    } finally {
      release();
      await Promise.allSettled([retry]);
    }
  });

  /** Czeka, aż zapytanie innej sesji pasujące do wzorca zawiśnie na blokadzie (jak w source-materials.test.ts). */
  async function waitUntilBlocked(pattern: RegExp, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let waiting: string[] = [];
    while (Date.now() < deadline) {
      const rows = await query<{ query: string }>(
        "select query from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()",
      );
      if (rows.some((row) => pattern.test(row.query))) return;
      waiting = rows.map((row) => row.query);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`zapytanie ${String(pattern)} nie czeka na blokadzie; czekają: ${JSON.stringify(waiting)}`);
  }

  // Obietnice w locie są deklarowane przed `try` i domykane w `finally` po zwolnieniu
  // blokady: nieudana asercja nie zostawia pracy w tle, która wpadłaby w następny test.
  it("usunięcie źródła czeka na tworzenie zestawu słówek i potem zeruje odnośnik, a zestaw zostaje z kopią tekstu", async () => {
    const sourceId = await seedSource();
    // Blokada tabeli wersji zatrzymuje tworzenie PO zablokowaniu źródła: wstawienie
    // zestawu czeka, a źródło jest już zablokowane `FOR KEY SHARE` (`lockSourceMaterialForCopy`).
    const blocker = await pool.connect();
    let creating: Promise<Outcome<Awaited<ReturnType<typeof enqueueDeckGeneration>>>> | undefined;
    let deleting: Promise<Outcome<void>> | undefined;
    try {
      await blocker.query("begin");
      await blocker.query("lock table learning_app.deck_versions in access exclusive mode");
      creating = settle(enqueueDeckGeneration(services, sourceCommand(sourceId)));
      await waitUntilBlocked(/insert into "learning_app"\."decks"/i);

      deleting = settle(deleteSourceMaterial(services, sourceId));
      await waitUntilBlocked(/delete from "learning_app"\."source_materials"/i);
      // Źródło wciąż istnieje: usuwanie czeka na blokadę trzymaną przez tworzenie.
      expect(await count("source_materials")).toBe(1);

      await blocker.query("commit");
      const created = await creating;
      expect(await deleting).toEqual({ ok: true, value: undefined });

      if (!created.ok) throw created.error;
      const stored = await storedVocabularyDeck(created.value.deckId);
      expect(stored.deck).toEqual({ title: SOURCE_TITLE, kind: "vocabulary", source_material_id: null, source_material_revision: 1 });
      expect(stored.run).toMatchObject({ id: created.value.runId, state: "queued" });
      expect(stored.run.input).toMatchObject({ mode: "material", material: CHAPTER_TEXT });
      expect(await count("source_materials")).toBe(0);
      expect(await readDeck(services, created.value.deckId)).not.toHaveProperty("source");
    } finally {
      await blocker.query("rollback").catch(() => undefined);
      blocker.release();
      await Promise.allSettled([creating, deleting]);
    }
  });

  it("readDeck pokazuje źródło z bieżącą rewizją treści i tytułem, a po usunięciu źródła pole znika", async () => {
    const sourceId = await seedSource();
    const { deckId } = await enqueueDeckGeneration(services, sourceCommand(sourceId));

    expect((await readDeck(services, deckId)).source).toEqual({ id: sourceId, title: SOURCE_TITLE, copiedRevision: 1, currentRevision: 1 });

    await updateSourceMaterial(services, sourceId, { expectedRevision: 1, title: "Pogoda (poprawiony)", body: "Nowy tekst rozdziału." });
    expect((await readDeck(services, deckId)).source).toEqual({ id: sourceId, title: "Pogoda (poprawiony)", copiedRevision: 1, currentRevision: 2 });
    // kopia w runie się nie zmienia
    expect((await storedVocabularyDeck(deckId)).run.input).toMatchObject({ material: CHAPTER_TEXT });

    await deleteSourceMaterial(services, sourceId);
    const afterDelete = await readDeck(services, deckId);
    expect(afterDelete).not.toHaveProperty("source");
    expect((await storedVocabularyDeck(deckId)).deck).toMatchObject({ source_material_id: null, source_material_revision: 1 });
    expect(afterDelete.generation).toMatchObject({ state: "queued", rejectedCount: null });
  });

  it("strona źródła wymienia zestaw słówek ze stanem i znacznikiem nieaktualności", async () => {
    const sourceId = await seedSource();
    const { deckId } = await enqueueDeckGeneration(services, sourceCommand(sourceId, { title: "Słówka z rozdziału" }));

    expect((await getSourceMaterial(services, sourceId)).decks).toEqual([
      { deckId, title: "Słówka z rozdziału", kind: "vocabulary", state: "draft", copiedRevision: 1, stale: false },
    ]);
    expect((await getSourceMaterial(services, sourceId)).deckCount).toBe(1);

    await updateSourceMaterial(services, sourceId, { expectedRevision: 1, body: "Tekst po zmianie." });
    expect((await getSourceMaterial(services, sourceId)).decks).toEqual([
      expect.objectContaining({ deckId, kind: "vocabulary", copiedRevision: 1, stale: true }),
    ]);
  });

  it("zestaw z opisu nie ma źródła, a jego run — liczby odrzuceń", async () => {
    const { runId, deckId } = await enqueueDeckGeneration(services, {
      prompt: "Dni tygodnia po angielsku dla 8-letniego dziecka.",
      idempotencyKey: "description-mode-1",
    });

    const stored = await storedVocabularyDeck(deckId);
    expect(stored.deck).toMatchObject({ source_material_id: null, source_material_revision: null });
    expect(stored.version.generation_prompt).toBe("Dni tygodnia po angielsku dla 8-letniego dziecka.");
    expect(stored.run.input).not.toHaveProperty("mode");
    expect(stored.run.input).toMatchObject({ prompt: "Dni tygodnia po angielsku dla 8-letniego dziecka." });
    expect((await readGeneration(services, runId)).rejectedCount).toBeNull();
    const deck = await readDeck(services, deckId);
    expect(deck).not.toHaveProperty("source");
    expect(deck.generation).toMatchObject({ id: runId, rejectedCount: null });
  });

  it("markRunSucceeded zapisuje sukces z liczbą odrzuceń widoczną w GenerationDto", async () => {
    const sourceId = await seedSource();
    const { runId, deckId } = await enqueueDeckGeneration(services, sourceCommand(sourceId));
    await pool.query("update learning_app.generation_runs set state = 'running', attempts = 1, error_code = 'stale' where id = $1", [runId]);
    clock.advanceMs(5 * 60_000);

    await services.db.transaction((tx) => markRunSucceeded(tx, services.clock, runId, 3));

    expect(await readGeneration(services, runId)).toMatchObject({ state: "succeeded", attempts: 1, errorCode: null, rejectedCount: 3 });
    expect((await readDeck(services, deckId)).generation).toMatchObject({ id: runId, state: "succeeded", rejectedCount: 3 });
    const [row] = await query<{ finished_at: Date; next_attempt_at: Date | null }>(
      "select finished_at, next_attempt_at from learning_app.generation_runs where id = $1", [runId],
    );
    expect(row!.finished_at.toISOString()).toBe("2026-10-31T10:05:00.000Z");
    expect(row!.next_attempt_at).toBeNull();

    // tryb opisu oznacza sukces bez liczby odrzuceń
    await markRunSucceeded(services.db, services.clock, runId, null);
    expect((await readGeneration(services, runId)).rejectedCount).toBeNull();
  });

  it("kolumna rejected_count przyjmuje null i zero, a CHECK odrzuca liczbę ujemną", async () => {
    const sourceId = await seedSource();
    const { runId } = await enqueueDeckGeneration(services, sourceCommand(sourceId));

    await pool.query("update learning_app.generation_runs set rejected_count = 0 where id = $1", [runId]);
    expect((await readGeneration(services, runId)).rejectedCount).toBe(0);
    await expect(pool.query("update learning_app.generation_runs set rejected_count = -1 where id = $1", [runId]))
      .rejects.toMatchObject({ code: "23514", constraint: "generation_runs_rejected_count_nonnegative" });
    expect((await readGeneration(services, runId)).rejectedCount).toBe(0);
  });
});

describe("słówka ze źródła — generowanie wyłącznie z tekstu (integracja)", () => {
  let fakes: FakeGeneration;
  let services: Services;
  let clock: ManualClock;

  beforeEach(async () => {
    await pool.query(
      `truncate learning_app.generation_runs, learning_app.revision_assets, learning_app.media_assets,
              learning_app.item_revision_skills, learning_app.item_revisions, learning_app.skill_versions,
              learning_app.learning_items, learning_app.deck_versions, learning_app.decks,
              learning_app.source_materials cascade`,
    );
    fakes = await fakeGeneration();
    const { db } = testDatabase();
    clock = new ManualClock("2026-10-31T10:00:00.000Z");
    services = createServices({ db, clock, media: fakes.settings, generation: fakes.deps });
  });

  afterEach(async () => {
    await fakes.dispose();
  });

  async function generateFromSource(overrides: Partial<GenerationCommand> = {}): Promise<{ runId: string; deckId: string }> {
    const sourceMaterialId = (await createSourceMaterial(services, { clientRequestId: randomUUID(), title: SOURCE_TITLE, body: CHAPTER_TEXT })).id;
    const created = await enqueueDeckGeneration(services, {
      sourceMaterialId,
      expectedSourceRevision: 1,
      idempotencyKey: `source-vocabulary-run-${randomUUID()}`,
      ...overrides,
    });
    await executeGeneration(services, created.runId);
    return created;
  }

  async function draftItems(deckId: string): Promise<Array<Record<string, unknown>>> {
    const rows = await query<{ payload: Record<string, unknown> }>(
      `select r.payload from learning_app.item_revisions r join learning_app.deck_versions v on v.id = r.deck_version_id
        where v.deck_id = $1 order by r.position`, [deckId],
    );
    return rows.map((row) => row.payload);
  }

  async function draftVersion(deckId: string): Promise<{ state: string; edit_number: number }> {
    const [version] = await query<{ state: string; edit_number: number }>(
      "select state, edit_number from learning_app.deck_versions where deck_id = $1", [deckId],
    );
    return version!;
  }

  const item = (target: string, source: string, extra: Record<string, unknown> = {}): Record<string, unknown> =>
    ({ source, target, acceptedAnswers: [], visualType: "none", ...extra });

  it("zostawia pozycje z tekstu, odrzuca spoza tekstu, ramę i element bez celu; liczba odrzuceń w runie i DTO", async () => {
    // zawężenie próbuje dodać słowa (plan Etapu 4, Review Focus 3), a model je dopisuje
    fakes.llm.queue({
      items: [
        item("the coats", "płaszcze"), // rodzajnik i liczba mnoga; w tekście „a coat” (Review Focus 2)
        item("red", "czerwony", { visualType: "color", visualData: { color: "#ff0000" } }),
        item("I'm wearing (a) …", "Mam na sobie…"), // rama będąca początkiem zdania tekstu
        item("wearing", "mieć na sobie"),
        { source: "buty", acceptedAnswers: [] }, // bez `target`
        item("umbrella", "parasol"),
        item("sunny", "słonecznie", { example: "It's sunny." }),
      ],
    });

    const { runId, deckId } = await generateFromSource({ instruction: "tylko ubrania i pogoda; dodaj kolory" });

    const request = fakes.llm.requests.at(-1)!;
    expect(request).toEqual({
      material: CHAPTER_TEXT,
      instruction: "tylko ubrania i pogoda; dodaj kolory",
      sourceLocale: "pl-PL",
      targetLocale: "en-GB",
      maxItems: 50,
      vocabularyFormat: "standard",
    });
    expect(await readGeneration(services, runId)).toMatchObject({ state: "succeeded", errorCode: null, rejectedCount: 4 });
    expect((await storedVocabularyDeck(deckId)).run.rejected_count).toBe(4);
    expect((await readDeck(services, deckId)).generation).toMatchObject({ id: runId, state: "succeeded", rejectedCount: 4 });
    expect(await draftVersion(deckId)).toMatchObject({ state: "review" });
    expect(await draftItems(deckId)).toEqual([
      expect.objectContaining({ target: "the coats", source: "płaszcze", sourceLocale: "pl-PL", targetLocale: "en-GB" }),
      expect.objectContaining({ target: "wearing", source: "mieć na sobie" }),
      expect.objectContaining({ target: "sunny", source: "słonecznie", example: "It's sunny." }),
    ]);
  });

  it("duplikat celu: pierwszy wygrywa, drugi odrzucony; słowa funkcyjne stojące w tekście zostają", async () => {
    fakes.llm.queue({
      items: [
        item("boots", "buty"),
        item("Boots", "kozaki"),
        item("it is", "to jest"), // same słowa funkcyjne, ale stoją w tekście („It's”) — zostają
        item("pink", "różowy"),
        item("where", "gdzie"), // słowo funkcyjne spoza tekstu — odrzucone jak każde inne
      ],
    });

    const { runId, deckId } = await generateFromSource();

    expect(await readGeneration(services, runId)).toMatchObject({ state: "succeeded", rejectedCount: 2 });
    expect((await draftItems(deckId)).map((payload) => [payload.target, payload.source])).toEqual([
      ["boots", "buty"], ["it is", "to jest"], ["pink", "różowy"],
    ]);
  });

  it("cel i warianty bez końcowej interpunkcji, z prostym apostrofem; odpowiedź dziecka bez kropki zaliczona", async () => {
    // model bierze zdanie z tekstu razem z kropką, a ocena pisemna porównuje interpunkcję co do znaku
    fakes.llm.queue({
      items: [
        item("It's raining.", "pada deszcz", { acceptedAnswers: ["It is raining.", "It's  raining", "?!"], example: "It's raining." }),
        item("It’s sunny!", "jest słonecznie", { acceptedAnswers: ["It’s sunny"] }),
        item("What's the weather like?", "jaka jest pogoda?"),
        // wizualizacja sprawdzana na zapisanym celu: „pink” z kolorem czerwonym odpada
        item("Pink.", "różowy", { visualType: "color", visualData: { color: "#ff0000" } }),
      ],
    });

    const { runId, deckId } = await generateFromSource();

    expect(await readGeneration(services, runId)).toMatchObject({ state: "succeeded", rejectedCount: 1 });
    const payloads = await draftItems(deckId);
    // wewnętrzna interpunkcja, przykład i polskie znaczenie bez zmian; puste i powtórzone warianty znikają
    expect(payloads.map((payload) => [payload.target, payload.acceptedAnswers, payload.source, payload.example])).toEqual([
      ["It's raining", ["It is raining"], "pada deszcz", "It's raining."],
      ["It's sunny", [], "jest słonecznie", undefined],
      ["What's the weather like", [], "jaka jest pogoda?", undefined],
    ]);

    const keyOf = (payload: Record<string, unknown>): AnswerKey => ({
      exerciseType: "recall",
      target: payload.target as string,
      acceptedAnswers: payload.acceptedAnswers as string[],
    });
    const [raining, sunny, weather] = payloads.map(keyOf);
    expect(matchWrittenAnswer("it's raining", raining!)).toMatchObject({ ci: true, matchedVariant: "It's raining" });
    expect(matchWrittenAnswer("it is raining", raining!)).toMatchObject({ ci: true, matchedVariant: "It is raining" });
    expect(matchWrittenAnswer("it's sunny", sunny!)).toMatchObject({ ci: true, matchedVariant: "It's sunny" });
    expect(matchWrittenAnswer("What's the weather like", weather!)).toMatchObject({ exact: true, ci: true });
  });

  it("duplikat po dopasowaniu: „a coat” po „coat” i „It's raining.” po „It's raining” odrzucone; odmiana zostaje", async () => {
    fakes.llm.queue({
      items: [
        item("coat", "płaszcz"),
        item("a coat", "płaszczyk"),
        item("It's raining", "pada"),
        item("It's raining.", "pada deszcz"),
        item("It’s raining!", "leje"),
        item("boots", "buty"),
        item("boot", "but"), // inna forma odmiany — osobna pozycja
        item("the Coat.", "ten płaszcz"),
      ],
    });

    const { runId, deckId } = await generateFromSource();

    expect(await readGeneration(services, runId)).toMatchObject({ state: "succeeded", rejectedCount: 4 });
    expect((await draftItems(deckId)).map((payload) => [payload.target, payload.source])).toEqual([
      ["coat", "płaszcz"], ["It's raining", "pada"], ["boots", "buty"], ["boot", "but"],
    ]);
  });

  it("odrzucony element nie zajmuje celu: niepoprawny pierwszy „boots”, poprawny drugi „Boots” zostaje", async () => {
    fakes.llm.queue({
      items: [
        { source: "buty", target: "boots", acceptedAnswers: [] }, // format obrazkowy bez `visualType`
        item("Boots", "kozaki", { visualType: "image" }),
      ],
    });

    const { runId, deckId } = await generateFromSource({ vocabularyFormat: "picture" });

    expect(await readGeneration(services, runId)).toMatchObject({ state: "succeeded", rejectedCount: 1 });
    expect((await draftItems(deckId)).map((payload) => [payload.target, payload.source, payload.visualType])).toEqual([
      ["Boots", "kozaki", "image"],
    ]);
  });

  it.each([
    ["lista nie jest tablicą", { items: "x" }],
    ["lista dłuższa niż trzykrotny limit zestawu", { items: Array.from({ length: 301 }, (_, i) => ({ source: `płaszcz ${i}`, target: "coat" })) }],
  ])("zły kształt wyniku modelu (%s): porażka walidacji bez liczby odrzuceń, szkic bez zmian", async (_label, result) => {
    fakes.llm.queue(result as unknown as LlmBehavior);

    const { runId, deckId } = await generateFromSource();

    expect(await readGeneration(services, runId)).toMatchObject({ state: "failed", errorCode: "validation", rejectedCount: null });
    expect(await draftVersion(deckId)).toEqual({ state: "draft", edit_number: 1 });
    expect(await draftItems(deckId)).toEqual([]);
  });

  it("błąd transportu providera: run wraca do kolejki jak w trybie opisu, a kolejna próba zapisuje szkic", async () => {
    fakes.llm.queue({ error: "llm timeout", retryable: true }, { items: [item("coat", "płaszcz")] });

    const { runId, deckId } = await generateFromSource();

    expect(await readGeneration(services, runId)).toMatchObject({ state: "queued", attempts: 1, errorCode: null, rejectedCount: null });
    expect(await draftVersion(deckId)).toEqual({ state: "draft", edit_number: 1 });
    expect(await draftItems(deckId)).toEqual([]);

    clock.advanceMs(60_000); // po odstępie ponowienia (#300)
    await executeGeneration(services, runId);
    expect(await readGeneration(services, runId)).toMatchObject({ state: "succeeded", attempts: 2, rejectedCount: 0 });
    expect(fakes.llm.requests).toHaveLength(2);
    expect(fakes.llm.requests.every((request) => "material" in request && request.material === CHAPTER_TEXT)).toBe(true);
    expect((await draftItems(deckId)).map((payload) => payload.target)).toEqual(["coat"]);
  });

  it("wszystkie pozycje spoza tekstu: porażka no_source_items z liczbą odrzuceń, szkic bez zmian; ponowienie zeruje liczbę", async () => {
    fakes.llm.queue({ items: [item("umbrella", "parasol"), item("red", "czerwony"), item("scarf", "szalik")] });

    const { runId, deckId } = await generateFromSource();

    expect(await readGeneration(services, runId)).toMatchObject({ state: "failed", errorCode: "no_source_items", rejectedCount: 3 });
    expect((await readDeck(services, deckId)).generation).toMatchObject({ state: "failed", errorCode: "no_source_items", rejectedCount: 3 });
    expect(await draftVersion(deckId)).toEqual({ state: "draft", edit_number: 1 });
    expect(await draftItems(deckId)).toEqual([]);
    expect(fakes.llm.requests).toHaveLength(1);

    // ręczne ponowienie: liczba odrzuceń należy do poprzedniej próby
    await retryGeneration(services, runId);
    expect(await readGeneration(services, runId)).toMatchObject({ state: "queued", errorCode: null, rejectedCount: null });
    fakes.llm.queue({ items: [item("coat", "płaszcz")] });
    await executeGeneration(services, runId);
    expect(await readGeneration(services, runId)).toMatchObject({ state: "succeeded", rejectedCount: 0 });
    expect((await draftItems(deckId)).map((payload) => payload.target)).toEqual(["coat"]);
  });

  it("pusty wynik modelu w trybie ze źródła to no_source_items bez odrzuceń, także w formacie obrazkowym", async () => {
    fakes.llm.queue({ items: [] });

    const { runId, deckId } = await generateFromSource({ vocabularyFormat: "picture" });

    expect(await readGeneration(services, runId)).toMatchObject({ state: "failed", errorCode: "no_source_items", rejectedCount: 0 });
    expect(await draftVersion(deckId)).toEqual({ state: "draft", edit_number: 1 });
  });

  it("pełny zestaw (maxItems) kończy sprawdzanie: dalsze pozycje nie są ani przyjęte, ani liczone jako odrzucone", async () => {
    fakes.llm.queue({ items: [item("coat", "płaszcz"), item("boots", "buty"), item("umbrella", "parasol"), item("raining", "pada deszcz")] });

    const { runId, deckId } = await generateFromSource({ maxItems: 2 });

    expect(fakes.llm.requests.at(-1)).toMatchObject({ maxItems: 2 });
    // „umbrella” spoza tekstu stoi już po zapełnieniu zestawu — nie jest liczona
    expect(await readGeneration(services, runId)).toMatchObject({ state: "succeeded", rejectedCount: 0 });
    expect((await draftItems(deckId)).map((payload) => payload.target)).toEqual(["coat", "boots"]);
  });

  it("odrzucenia przed zapełnieniem zestawu się liczą", async () => {
    fakes.llm.queue({ items: [item("umbrella", "parasol"), item("coat", "płaszcz"), item("scarf", "szalik"), item("boots", "buty"), item("hat", "czapka")] });

    const { runId, deckId } = await generateFromSource({ maxItems: 2 });

    expect(await readGeneration(services, runId)).toMatchObject({ state: "succeeded", rejectedCount: 2 });
    expect((await draftItems(deckId)).map((payload) => payload.target)).toEqual(["coat", "boots"]);
  });

  it("format obrazkowy: pozycja bez reprezentacji obrazkowej odrzucona, poprawne zostają", async () => {
    fakes.llm.queue({
      items: [
        item("boots", "buty", { visualType: "image" }),
        { source: "płaszcz", target: "coat", acceptedAnswers: [] }, // bez `visualType` — domyślnie none
        item("pink", "różowy", { visualType: "color", visualData: { color: "#ffc0cb" } }),
      ],
    });

    const { runId, deckId } = await generateFromSource({ vocabularyFormat: "picture" });

    expect(fakes.llm.requests.at(-1)).toMatchObject({ vocabularyFormat: "picture" });
    expect(await readGeneration(services, runId)).toMatchObject({ state: "succeeded", rejectedCount: 1 });
    expect((await draftItems(deckId)).map((payload) => [payload.target, payload.visualType])).toEqual([["boots", "image"], ["pink", "color"]]);
  });

  it("bez kolejki fałszywy LLM daje słowa treści z tekstu i żadna pozycja nie jest odrzucana", async () => {
    const { runId, deckId } = await generateFromSource({ maxItems: 4 });

    expect(await readGeneration(services, runId)).toMatchObject({ state: "succeeded", rejectedCount: 0 });
    expect(await draftItems(deckId)).toEqual([
      expect.objectContaining({ target: "weather", source: "„weather” po polsku", example: "What's the weather like?" }),
      expect.objectContaining({ target: "like" }),
      expect.objectContaining({ target: "sunny", example: "It's sunny." }),
      expect.objectContaining({ target: "raining", example: "It's raining." }),
    ]);
  });

  it("tryb opisu bez zmian: jedna zła pozycja to porażka walidacji całości, a sukces nie ma liczby odrzuceń", async () => {
    fakes.llm.queue({ items: [item("Monday", "poniedziałek"), item("", "wtorek")] });
    const broken = await enqueueDeckGeneration(services, { prompt: "Dni tygodnia po angielsku.", idempotencyKey: `description-${randomUUID()}` });
    await executeGeneration(services, broken.runId);

    expect(fakes.llm.requests.at(-1)).toEqual({ prompt: "Dni tygodnia po angielsku.", sourceLocale: "pl-PL", targetLocale: "en-GB", maxItems: 50, vocabularyFormat: "standard" });
    expect(await readGeneration(services, broken.runId)).toMatchObject({ state: "failed", errorCode: "validation", rejectedCount: null });
    expect(await draftItems(broken.deckId)).toEqual([]);
    expect(await draftVersion(broken.deckId)).toEqual({ state: "draft", edit_number: 1 });

    // słowa spoza jakiegokolwiek tekstu i bez sprawdzania fraz — tryb opisu nie zna materiału
    fakes.llm.queue({ items: [item("Monday", "poniedziałek"), item("Tuesday", "wtorek")] });
    const ok = await enqueueDeckGeneration(services, { prompt: "Dni tygodnia po angielsku.", idempotencyKey: `description-${randomUUID()}` });
    await executeGeneration(services, ok.runId);
    expect(await readGeneration(services, ok.runId)).toMatchObject({ state: "succeeded", rejectedCount: null });
    expect((await draftItems(ok.deckId)).map((payload) => payload.target)).toEqual(["Monday", "Tuesday"]);
  });
});
