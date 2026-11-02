import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDraft,
  createLesson,
  createServices,
  createSubjectRegistry,
  editDraft,
  englishGrammarSubject,
  executeLessonGeneration,
  executeMediaAsset,
  publishDraft,
  publishLessonDraft,
  readDraft,
  readLessonDeck,
  reconcileDraftAssets,
  runDueGenerationWork,
  type Services,
} from "@learning/server";
import type { VocabularyItemInput } from "@learning/contracts";
import { assertAssetPublishable } from "../../packages/server/src/modules/materials/media-reconciliation";
import { grammarWithoutSentenceAudio, ManualClock, testDatabase, truncateCoreTables } from "./helpers";
import { fakeGeneration, type FakeGeneration } from "./fakes";

/*
 * Issue #106: publikacja uzgadniała media w tej samej transakcji co walidację
 * gotowości. Walidacja padała na zasobie `pending`, a ROLLBACK zabierał świeżo
 * zlecone zasoby i zadania generacji — worker ich nie widział i każda kolejna
 * próba publikacji kończyła się tak samo.
 */

const { db, pool } = testDatabase();
const disposers: Array<() => Promise<void>> = [];

beforeEach(async () => {
  await truncateCoreTables();
  await pool.query(
    `truncate learning_app.generation_runs, learning_app.revision_assets, learning_app.media_assets,
            learning_app.item_revision_skills, learning_app.item_revisions, learning_app.skill_versions,
            learning_app.learning_items, learning_app.deck_versions, learning_app.decks cascade`,
  );
});

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

afterAll(async () => {
  await pool.end();
});

async function fakes(): Promise<FakeGeneration> {
  const created = await fakeGeneration();
  disposers.push(created.dispose);
  return created;
}

function services(generation: FakeGeneration, overrides: Partial<Parameters<typeof createServices>[0]> = {}): Services {
  return createServices({ db, clock: new ManualClock(), media: generation.settings, generation: generation.deps, ...overrides });
}

const item = (overrides: Partial<VocabularyItemInput> = {}): VocabularyItemInput => ({
  source: "czwartek",
  target: "Thursday",
  acceptedAnswers: [],
  locales: { source: "pl-PL", target: "en-GB" },
  visualType: "none",
  ...overrides,
});

async function count(table: string, where = "true"): Promise<number> {
  return (await pool.query(`select count(*)::int as count from learning_app.${table} where ${where}`)).rows[0].count;
}

async function versionRow(id: string): Promise<{ state: string; edit_number: number }> {
  return (await pool.query("select state, edit_number from learning_app.deck_versions where id = $1", [id])).rows[0];
}

async function drainGeneration(target: Services): Promise<void> {
  for (let pass = 0; pass < 10; pass += 1) {
    const result = await runDueGenerationWork(target, { lesson: 0, deck: 0, tts: 50, images: 50 });
    if (result.processed === 0) return;
  }
}

describe("publikacja zleca brakujące media trwale (issue #106)", () => {
  it("nieudana publikacja słówek zostawia zlecone media, a po ich wygenerowaniu publikacja przechodzi", async () => {
    const generation = await fakes();
    const app = services(generation);
    const draft = await createDraft(app, { title: "Dni", items: [item(), item({ source: "piątek", target: "Friday" })] });
    expect(await count("generation_runs", "kind = 'tts'")).toBe(0);

    await expect(publishDraft(app, draft.id, draft.editNumber)).rejects.toMatchObject({
      code: "validation",
      details: { media: "pending" },
    });

    // uzgodnienie przetrwało nieudaną walidację: worker ma co robić
    expect(await count("media_assets", "state = 'pending'")).toBe(2);
    expect(await count("generation_runs", "kind = 'tts' and state = 'queued'")).toBe(2);
    // szkic się nie zmienił: numer edycji bez zmian, rodzic może dalej edytować
    expect(await versionRow(draft.id)).toEqual({ state: "draft", edit_number: draft.editNumber });
    expect((await readDraft(app, draft.id)).assets.filter((asset) => asset.state === "pending")).toHaveLength(2);

    // druga próba przed wygenerowaniem nie mnoży zleceń
    await expect(publishDraft(app, draft.id, draft.editNumber)).rejects.toMatchObject({ code: "validation" });
    expect(await count("generation_runs", "kind = 'tts'")).toBe(2);

    await drainGeneration(app);
    await expect(publishDraft(app, draft.id, draft.editNumber)).resolves.toEqual({ deckVersionId: draft.id });
    expect((await versionRow(draft.id)).state).toBe("published");
    const links = (await pool.query("select state from learning_app.revision_assets where role = 'target_audio'")).rows;
    expect(links).toEqual([{ state: "approved" }, { state: "approved" }]);
  });

  it("zmiana ustawień mediów po generacji (nowe fingerprinty) nie zapętla publikacji", async () => {
    const generation = await fakes();
    const before = services(generation);
    const draft = await createDraft(before, { title: "Dni", items: [item()] });
    await reconcileDraftAssets(before, draft.id);
    await drainGeneration(before);
    const oldAsset = (await pool.query("select id, fingerprint from learning_app.media_assets")).rows[0];

    // jak po wdrożeniu #105: te same karty, inne wymagane fingerprinty
    const after = services(generation, { media: { ...generation.settings, tts: { ...generation.settings.tts, voice: "nova" } } });
    await expect(publishDraft(after, draft.id, draft.editNumber)).rejects.toMatchObject({ code: "validation" });

    const fresh = (await pool.query("select id, state, fingerprint from learning_app.media_assets where id <> $1", [oldAsset.id])).rows;
    expect(fresh).toHaveLength(1);
    expect(fresh[0].state).toBe("pending");
    expect(fresh[0].fingerprint).not.toBe(oldAsset.fingerprint);
    expect(await count("generation_runs", `asset_id = '${fresh[0].id}' and state = 'queued'`)).toBe(1);
    // stary gotowy zasób zostaje nietknięty w cache
    expect((await pool.query("select state from learning_app.media_assets where id = $1", [oldAsset.id])).rows[0].state).toBe("ready");

    await drainGeneration(after);
    await expect(publishDraft(after, draft.id, draft.editNumber)).resolves.toEqual({ deckVersionId: draft.id });
  });

  it("publikacja nie ponawia nieudanej ilustracji: rodzic decyduje o regeneracji albo pominięciu", async () => {
    const generation = await fakes();
    const app = services(generation);
    const draft = await createDraft(app, { title: "Dni", items: [item({ visualType: "image" })] });
    await reconcileDraftAssets(app, draft.id);
    generation.image.failuresLeft = 3;
    // trzy przebiegi workera wyczerpują próby ilustracji (jak w media.test.ts)
    for (let pass = 0; pass < 3; pass += 1) await runDueGenerationWork(app);
    expect(await count("media_assets", "kind = 'illustration' and state = 'failed'")).toBe(1);
    const imageRuns = await count("generation_runs", "kind = 'illustration'");

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const rejection = await publishDraft(app, draft.id, draft.editNumber).catch((error: unknown) => error);
      expect(rejection).toMatchObject({ code: "validation" });
      expect(rejection).not.toMatchObject({ details: { media: "pending" } });
    }
    // żadna kosztowna generacja bez jawnego „Regeneruj”
    expect(await count("generation_runs", "kind = 'illustration'")).toBe(imageRuns);
    expect(await count("media_assets", "kind = 'illustration' and state = 'pending'")).toBe(0);
    expect(generation.image.requests).toHaveLength(3);
    expect((await readDraft(app, draft.id)).assets.find((asset) => asset.role === "illustration")?.state).toBe("failed");
  });

  it("nieudany zasób na dalszej karcie wygrywa z generacją na wcześniejszej", async () => {
    const generation = await fakes();
    const app = services(generation);
    const draft = await createDraft(app, { title: "Dni", items: [item(), item({ source: "piątek", target: "Friday" })] });
    await reconcileDraftAssets(app, draft.id);
    // karta 0 czeka na generację, karta 1 ma audio, którego generacja się nie udała
    await pool.query(
      `update learning_app.media_assets set state = 'failed'
        where id = (select ra.asset_id from learning_app.revision_assets ra
                      join learning_app.item_revisions ir on ir.id = ra.item_revision_id
                     where ir.deck_version_id = $1 and ir.position = 1 and ra.role = 'target_audio')`,
      [draft.id],
    );

    const rejection = await publishDraft(app, draft.id, draft.editNumber).catch((error: unknown) => error);
    expect(rejection).toMatchObject({ code: "validation" });
    // rodzic nie czeka na media, których generacja nie usunie problemu
    expect(rejection).not.toMatchObject({ details: { media: "pending" } });
  });

  it("zasób gotowy dopiero po uzgodnieniu nie publikuje powiązania, którego sesja nie wybierze", async () => {
    const generation = await fakes();
    const app = services(generation);
    const draft = await createDraft(app, { title: "Dni", items: [item()] });
    await reconcileDraftAssets(app, draft.id);
    const link = (await pool.query(
      `select ra.item_revision_id, ra.asset_id, ra.expected_fingerprint, ra.state
         from learning_app.revision_assets ra
         join learning_app.item_revisions ir on ir.id = ra.item_revision_id
        where ir.deck_version_id = $1 and ra.role = 'target_audio'`,
      [draft.id],
    )).rows[0];
    expect(link.state).toBe("pending");
    // worker kończy generację między uzgodnieniem a walidacją publikacji
    await executeMediaAsset(app, link.asset_id);
    expect((await pool.query("select state from learning_app.media_assets where id = $1", [link.asset_id])).rows[0].state).toBe("ready");

    // sesje wybierają tylko powiązania approved, więc to jeszcze nie jest gotowe
    await expect(assertAssetPublishable(db, {
      itemRevisionId: link.item_revision_id,
      role: "target_audio",
      assetId: link.asset_id,
      expectedFingerprint: link.expected_fingerprint,
      linkState: link.state,
    })).resolves.toBe("pending");
    // kolejna publikacja promuje powiązanie i przechodzi
    await expect(publishDraft(app, draft.id, draft.editNumber)).resolves.toEqual({ deckVersionId: draft.id });
    expect((await pool.query("select state from learning_app.revision_assets where item_revision_id = $1 and role = 'target_audio'", [link.item_revision_id])).rows[0].state).toBe("approved");
  });

  it("nieaktualny numer edycji to konflikt bez uzgadniania mediów", async () => {
    const generation = await fakes();
    const app = services(generation);
    const draft = await createDraft(app, { title: "Dni", items: [item()] });
    await expect(publishDraft(app, draft.id, draft.editNumber + 1)).rejects.toMatchObject({ code: "conflict" });
    expect(await count("media_assets")).toBe(0);
    expect(await count("generation_runs")).toBe(0);
  });

  it("edycja między nieudaną publikacją a ponowieniem wymaga nowego numeru edycji", async () => {
    const generation = await fakes();
    const app = services(generation);
    const draft = await createDraft(app, { title: "Dni", items: [item()] });
    await expect(publishDraft(app, draft.id, draft.editNumber)).rejects.toMatchObject({ code: "validation" });
    const edited = await editDraft(app, draft.id, { title: "Dni tygodnia", expectedEditNumber: draft.editNumber });
    await drainGeneration(app);
    await expect(publishDraft(app, draft.id, draft.editNumber)).rejects.toMatchObject({ code: "conflict" });
    await expect(publishDraft(app, draft.id, edited.editNumber)).resolves.toEqual({ deckVersionId: draft.id });
  });

  it("publikacja lekcji z wymaganym audio odpowiedzi zleca je trwale i przechodzi po generacji", async () => {
    const generation = await fakes();
    // lekcja wygenerowana bez audio, potem przedmiot zaczyna go wymagać (zmiana konfiguracji)
    const withoutAudio = services(generation, { subjects: createSubjectRegistry([grammarWithoutSentenceAudio]) });
    const run = await createLesson(withoutAudio, {
      subjectId: "english_grammar", topicId: "present_simple", objectiveIds: ["english_grammar.present_simple.third_person_s"],
      material: "He plays football. She reads books. She watches TV.", poolSize: 20, clientRequestId: randomUUID(),
    });
    await executeLessonGeneration(withoutAudio, run.runId);
    const draft = (await readLessonDeck(withoutAudio, run.deckId)).draft!;
    expect(await count("media_assets")).toBe(0);

    const withAudio = services(generation, { subjects: createSubjectRegistry([{ ...englishGrammarSubject, ttsForAnswers: true }]) });
    await expect(publishLessonDraft(withAudio, draft.id, draft.editNumber)).rejects.toMatchObject({
      code: "validation",
      details: { media: "pending" },
    });
    expect(await count("generation_runs", "kind = 'tts' and state = 'queued'")).toBeGreaterThan(0);

    await drainGeneration(withAudio);
    await expect(publishLessonDraft(withAudio, draft.id, draft.editNumber)).resolves.toEqual({ deckVersionId: draft.id });
  });
});
