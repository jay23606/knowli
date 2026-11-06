import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDraft,
  createServices,
  editDraft,
  executeGeneration,
  executeMediaAsset,
  publishDraft,
  readDraft,
  reconcileDraftAssets,
  regenerateRevisionAsset,
  runDueGenerationWork,
  type Services,
} from "@learning/server";
import type { VocabularyItemInput } from "@learning/contracts";
import { countRows, testDatabase, truncateCoreTables } from "./helpers";
import { ManualClock } from "./helpers";
import { fakeGeneration, staleLeaseToken, type FakeGeneration } from "./fakes";

const { pool } = testDatabase();

async function query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await pool.query(sql, params);
  return result.rows as T[];
}

function mediaServices(fakes: FakeGeneration, clock = new ManualClock()): Services {
  const { db } = testDatabase();
  return createServices({ db, clock, media: fakes.settings, generation: fakes.deps });
}

const LOCALES = { source: "pl-PL", target: "en-GB" };

function item(overrides: Partial<VocabularyItemInput> = {}): VocabularyItemInput {
  return {
    source: "czwartek",
    target: "Thursday",
    acceptedAnswers: [],
    locales: LOCALES,
    visualType: "none",
    ...overrides,
  };
}

interface AssetLink {
  asset_id: string | null;
  expected_fingerprint: string;
  state: string;
}

async function assetLink(deckVersionId: string, index: number, role: string): Promise<AssetLink> {
  return (
    await query<AssetLink>(
      `select ra.asset_id, ra.expected_fingerprint, ra.state
         from learning_app.revision_assets ra
         join learning_app.item_revisions ir on ir.id = ra.item_revision_id
        where ir.deck_version_id = $1 and ir.position = $2 and ra.role = $3`,
      [deckVersionId, index, role],
    )
  )[0]!;
}

interface AssetRow {
  id: string;
  kind: string;
  fingerprint: string;
  generation_number: number;
  state: string;
  storage_key: string | null;
  content_sha256: string | null;
  lease_token: string | null;
  byte_count: number | null;
}

async function assetRow(assetId: string): Promise<AssetRow> {
  return (
    await query<AssetRow>(
      `select id, kind, fingerprint, generation_number, state, storage_key, content_sha256,
              lease_token, byte_count
         from learning_app.media_assets where id = $1`,
      [assetId],
    )
  )[0]!;
}

type AssetRun = { id: string; state: string; attempts: number; error_code: string | null; next_attempt_at: Date | null };

async function runOfAsset(assetId: string): Promise<AssetRun> {
  return (
    await query<AssetRun>(
      `select id, state, attempts, error_code, next_attempt_at from learning_app.generation_runs where asset_id = $1`,
      [assetId],
    )
  )[0]!;
}

/** Zajmuje lease zasobu w imieniu "workera A" — symulacja zadania w locie. */
/** Lease względem zegara usług — SQL now() żyje w czasie rzeczywistym i postarzałby test. */
async function holdLease(assetId: string, token: string, expiresInMinutes: number): Promise<void> {
  const base = new ManualClock().now().toISOString();
  await pool.query(
    `update learning_app.media_assets set lease_token = $1, lease_until = $2::timestamptz + ($3 || ' minutes')::interval
      where id = $4`,
    [token, base, String(expiresInMinutes), assetId],
  );
}

describe("zasoby medialne i uzgodnienia szkicu (integracja)", () => {
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
    for (const dispose of disposers.splice(0)) {
      await dispose();
    }
  });

  afterAll(async () => {
    await pool.end();
  });

  it("TTS o tym samym fingerprintie używa jednego zasobu i jednego runu", async () => {
    const fakes = await fakeGeneration();
    disposers.push(fakes.dispose);
    const services = mediaServices(fakes);

    const a = await createDraft(services, { title: "A", items: [item()] });
    const b = await createDraft(services, { title: "B", items: [item()] });
    await reconcileDraftAssets(services, a.id);
    await reconcileDraftAssets(services, b.id);

    expect(await countRows("media_assets")).toBe(1);
    expect(await countRows("generation_runs")).toBe(1);

    const linkA = await assetLink(a.id, 0, "target_audio");
    const linkB = await assetLink(b.id, 0, "target_audio");
    expect(linkA.asset_id).toBe(linkB.asset_id);
    expect(linkA.state).toBe("pending");

    await executeMediaAsset(services, linkA.asset_id!);
    expect((await assetRow(linkA.asset_id!)).state).toBe("ready");

    // dopiero kolejne uzgodnienie promuje gotowe powiązanie; worker nie rusza szkiców
    await reconcileDraftAssets(services, a.id);
    await reconcileDraftAssets(services, b.id);
    expect((await assetLink(a.id, 0, "target_audio")).state).toBe("approved");
    expect((await assetLink(b.id, 0, "target_audio")).state).toBe("approved");
    expect(await countRows("media_assets")).toBe(1);
  });

  it("wejście executeGeneration wykonuje run TTS i zachowuje idempotencję", async () => {
    const fakes = await fakeGeneration();
    disposers.push(fakes.dispose);
    const services = mediaServices(fakes);
    const draft = await createDraft(services, { title: "Dni", items: [item()] });
    await reconcileDraftAssets(services, draft.id);
    const assetId = (await assetLink(draft.id, 0, "target_audio")).asset_id!;
    const run = await runOfAsset(assetId);

    await executeGeneration(services, run.id);

    const readyAsset = await assetRow(assetId);
    const succeededRun = await runOfAsset(assetId);
    expect(readyAsset.state).toBe("ready");
    expect(succeededRun.state).toBe("succeeded");
    expect(succeededRun.attempts).toBe(1);
    expect(fakes.tts.callsFor("Thursday")).toBe(1);

    await executeGeneration(services, run.id);

    const repeatedAsset = await assetRow(assetId);
    const repeatedRun = await runOfAsset(assetId);
    expect(repeatedAsset.state).toBe("ready");
    expect(repeatedAsset.storage_key).toBe(readyAsset.storage_key);
    expect(repeatedAsset.content_sha256).toBe(readyAsset.content_sha256);
    expect(repeatedRun.state).toBe("succeeded");
    expect(repeatedRun.attempts).toBe(1);
    expect(fakes.tts.callsFor("Thursday")).toBe(1);
  });

  it("ponawia historyczną ilustrację modelem zapisanym w zasobie, gdy metadata nie ma modelu", async () => {
    const fakes = await fakeGeneration();
    disposers.push(fakes.dispose);
    const services = mediaServices(fakes);
    const dto = await createDraft(services, {
      title: "Zwierzęta",
      items: [item({ visualType: "image", visualData: { imagePrompt: "A small cat" } })],
    });
    await reconcileDraftAssets(services, dto.id);
    const illustration = await assetLink(dto.id, 0, "illustration");
    const assetId = illustration.asset_id!;

    await pool.query(
      `update learning_app.media_assets
          set model = 'gpt-image-1', metadata = metadata - 'model'
        where id = $1`,
      [assetId],
    );

    await executeMediaAsset(services, assetId);

    expect(fakes.image.requests.at(-1)?.model).toBe("gpt-image-1");
  });

  it("media job wiąże się z asset_id: zmiana ilustracji jednej karty nie unieważnia TTS innej", async () => {
    const fakes = await fakeGeneration();
    disposers.push(fakes.dispose);
    const services = mediaServices(fakes);

    const dto = await createDraft(services, {
      title: "Dni",
      items: [item(), item({ source: "piątek", target: "Friday", visualType: "image" })],
    });
    await reconcileDraftAssets(services, dto.id);
    expect(await countRows("media_assets")).toBe(3);

    const thursdayTts = await assetLink(dto.id, 0, "target_audio");
    const fridayIllOld = await assetLink(dto.id, 1, "illustration");

    // TTS czwartku w locie: worker A trzyma lease
    const ownerToken = staleLeaseToken();
    await holdLease(thursdayTts.asset_id!, ownerToken, 10);

    // rodzic dostraja prompt ilustracji piątku
    await editDraft(services, dto.id, {
      items: [
        { ...item(), id: dto.items[0]!.id },
        {
          ...item({ source: "piątek", target: "Friday", visualType: "image" }),
          visualData: { imagePrompt: "cartoon sunset over a calendar" },
          id: dto.items[1]!.id,
        },
      ],
      expectedEditNumber: 1,
    });

    expect(await countRows("media_assets")).toBe(4);
    const fridayIllNew = await assetLink(dto.id, 1, "illustration");
    expect(fridayIllNew.asset_id).not.toBe(fridayIllOld.asset_id);
    expect(fridayIllNew.expected_fingerprint).not.toBe(fridayIllOld.expected_fingerprint);

    // TTS czwartku: ten sam zasób, lease nietknięty
    const thursdayTtsAfter = await assetLink(dto.id, 0, "target_audio");
    expect(thursdayTtsAfter.asset_id).toBe(thursdayTts.asset_id);
    const leased = await assetRow(thursdayTts.asset_id!);
    expect(leased.lease_token).toBe(ownerToken);
    expect(leased.state).toBe("pending");

    // worker A finalizuje CAS-em na własnym tokenie
    const finalized = await pool.query(
      `update learning_app.media_assets
          set state='ready', storage_key='blob/thursday', content_sha256='sha-thursday',
              mime_type='audio/mpeg', byte_count=64, lease_token=null, lease_until=null
        where id=$1 and lease_token=$2`,
      [thursdayTts.asset_id, ownerToken],
    );
    expect(finalized.rowCount).toBe(1);
    expect((await assetLink(dto.id, 0, "target_audio")).asset_id).toBe(thursdayTts.asset_id);
  });

  it("nieudana ilustracja nie niszczy szkicu; publikacja czeka na decyzję rodzica", async () => {
    const fakes = await fakeGeneration();
    disposers.push(fakes.dispose);
    const clock = new ManualClock();
    const services = mediaServices(fakes, clock);

    const dto = await createDraft(services, {
      title: "Dni",
      items: [item({ visualType: "image" })],
    });
    await reconcileDraftAssets(services, dto.id);
    const ttsLink = await assetLink(dto.id, 0, "target_audio");
    const illLink = await assetLink(dto.id, 0, "illustration");

    fakes.image.failuresLeft = 3;
    // ponowienie czeka na odstęp (#300): kolejny przebieg przed `next_attempt_at` nie woła providera
    await runDueGenerationWork(services);
    expect(fakes.image.requests).toHaveLength(1);
    const deferred = await runOfAsset(illLink.asset_id!);
    expect(deferred.state).toBe("queued");
    expect(new Date(deferred.next_attempt_at!).getTime()).toBeGreaterThan(clock.now().getTime());
    await runDueGenerationWork(services);
    expect(fakes.image.requests).toHaveLength(1);
    for (let pass = 0; pass < 2; pass += 1) {
      clock.advanceMs(60_000);
      await runDueGenerationWork(services);
    }

    expect((await assetRow(ttsLink.asset_id!)).state).toBe("ready");
    const ill = await assetRow(illLink.asset_id!);
    expect(ill.state).toBe("failed");
    const illRun = await runOfAsset(illLink.asset_id!);
    expect(illRun.state).toBe("failed");
    expect(illRun.error_code).toBe("attempts_exhausted");
    expect(fakes.image.requests).toHaveLength(3);

    // DTO dla rodzica mówi wprost o porażce — nie "generowanie…" na zawsze
    const failedDraft = await readDraft(services, dto.id);
    const failedAssets = failedDraft.assets.filter((a) => a.role === "illustration");
    expect(failedAssets).toHaveLength(1);
    expect(failedAssets[0]!.state).toBe("failed");
    expect(failedDraft.assets.filter((a) => a.role === "target_audio")[0]!.state).toBe("approved");

    // szkic żyje: edycja działa, publikacja blokowana niezdecydowaną ilustracją
    await editDraft(services, dto.id, { title: "Dni tygodnia", expectedEditNumber: 1 });
    await expect(
      publishDraft(services, dto.id, 2),
    ).rejects.toMatchObject({ code: "validation" });

    // świadome pominięcie odblokowuje publikację (operacja rodzica wchodzi w zadaniu 4)
    await pool.query(
      `update learning_app.revision_assets set state='omitted' where item_revision_id=$1 and role='illustration'`,
      [dto.items[0]!.revisionId],
    );
    await publishDraft(services, dto.id, 2);
    const version = (
      await query<{ state: string }>("select state from learning_app.deck_versions where id = $1", [dto.id])
    )[0]!;
    expect(version.state).toBe("published");
  });

  it("Review Focus 1: worker zatrzymany po wyniku, przed zapisem — ponowienie kończy się jednym zasobem i runem", async () => {
    const fakes = await fakeGeneration();
    disposers.push(fakes.dispose);
    const services = mediaServices(fakes);

    const dto = await createDraft(services, { title: "Dni", items: [item()] });
    await reconcileDraftAssets(services, dto.id);
    const link = await assetLink(dto.id, 0, "target_audio");
    const assetId = link.asset_id!;

    // worker A: wygasły lease, wynik providera uzyskany, zapisu brak (crash)
    const crashedToken = staleLeaseToken();
    await holdLease(assetId, crashedToken, -1);
    const paidBytes = await fakes.tts.synthesize({
      text: "Thursday",
      locale: "en-GB",
      voice: "fake-voice",
      format: "mp3",
    });
    expect(fakes.tts.callsFor("Thursday")).toBe(1);

    // worker B przejmuje wygasły lease i finalizuje
    await executeMediaAsset(services, assetId);

    const asset = await assetRow(assetId);
    expect(asset.state).toBe("ready");
    expect(asset.lease_token).toBeNull();
    expect(asset.storage_key).toBeTruthy();
    expect(asset.content_sha256).toBeTruthy();

    const run = await runOfAsset(assetId);
    expect(run.state).toBe("succeeded");
    expect(fakes.tts.callsFor("Thursday")).toBe(2);

    // jeden logiczny blob: te same bajty → ten sam klucz treści
    const blob = await fakes.store.get(asset.storage_key!);
    expect(blob).not.toBeNull();
    expect(Buffer.from(blob!.bytes).equals(Buffer.from(paidBytes.bytes))).toBe(true);

    // późna finalizeacja starego właściciela nie zmienia gotowego zasobu
    const late = await pool.query(
      `update learning_app.media_assets set state='failed' where id=$1 and lease_token=$2`,
      [assetId, crashedToken],
    );
    expect(late.rowCount).toBe(0);
    await expect(
      pool.query(`update learning_app.media_assets set byte_count=1 where id=$1`, [assetId]),
    ).rejects.toThrow();
    expect((await assetRow(assetId)).state).toBe("ready");
  });

  it("współdzielony zasób: równoległe wykonania dają jedno wywołanie providera", async () => {
    const fakes = await fakeGeneration();
    disposers.push(fakes.dispose);
    const services = mediaServices(fakes);

    const dto = await createDraft(services, { title: "Dni", items: [item()] });
    await reconcileDraftAssets(services, dto.id);
    const assetId = (await assetLink(dto.id, 0, "target_audio")).asset_id!;

    await Promise.allSettled([
      executeMediaAsset(services, assetId),
      executeMediaAsset(services, assetId),
    ]);

    expect((await assetRow(assetId)).state).toBe("ready");
    expect(fakes.tts.callsFor("Thursday")).toBe(1);
    expect((await runOfAsset(assetId)).attempts).toBe(1);
  });

  it("ręczna regeneracja tworzy nowy zasób i numer generacji; opublikowane audio bez zmian", async () => {
    const fakes = await fakeGeneration();
    disposers.push(fakes.dispose);
    const services = mediaServices(fakes);

    const deckA = await createDraft(services, { title: "A", items: [item()] });
    await reconcileDraftAssets(services, deckA.id);
    await runDueGenerationWork(services);
    const first = await assetLink(deckA.id, 0, "target_audio");
    const firstRow = await assetRow(first.asset_id!);
    expect(firstRow.state).toBe("ready");
    await publishDraft(services, deckA.id, 1);

    // drugi zestaw z tym samym słowem dołącza do współdzielonego gotowego zasobu
    const deckB = await createDraft(services, { title: "B", items: [item()] });
    await reconcileDraftAssets(services, deckB.id);
    expect((await assetLink(deckB.id, 0, "target_audio")).asset_id).toBe(first.asset_id);

    const regenerated = await regenerateRevisionAsset(services, {
      draftId: deckB.id,
      itemRevisionId: deckB.items[0]!.revisionId,
      role: "target_audio",
    });

    const newRow = await assetRow(regenerated.assetId);
    expect(newRow.id).not.toBe(first.asset_id);
    expect(newRow.fingerprint).toBe(firstRow.fingerprint);
    expect(newRow.generation_number).toBe(2);
    expect(newRow.state).toBe("pending");

    const linkB = await assetLink(deckB.id, 0, "target_audio");
    expect(linkB.asset_id).toBe(regenerated.assetId);
    expect(linkB.state).toBe("pending");

    await executeMediaAsset(services, regenerated.assetId);
    const readyNew = await assetRow(regenerated.assetId);
    expect(readyNew.state).toBe("ready");
    // te same ustawienia → te same bajty → ten sam niezmienny blob
    expect(readyNew.storage_key).toBe(firstRow.storage_key);
    expect(readyNew.content_sha256).toBe(firstRow.content_sha256);

    // opublikowany zestaw A wciąż wskazuje stary, niezmieniony zasób
    const firstAfter = await assetRow(first.asset_id!);
    expect(firstAfter).toMatchObject({
      state: "ready",
      storage_key: firstRow.storage_key,
      content_sha256: firstRow.content_sha256,
      byte_count: firstRow.byte_count,
    });
    const publishedLink = await assetLink(deckA.id, 0, "target_audio");
    expect(publishedLink.asset_id).toBe(first.asset_id);

    await publishDraft(services, deckB.id, 1);
  });

  it("zmiana tekstu zmienia fingerprint audio: stary zasób zostaje w cache, szkic dostaje nowy", async () => {
    const fakes = await fakeGeneration();
    disposers.push(fakes.dispose);
    const services = mediaServices(fakes);

    const dto = await createDraft(services, { title: "Dni", items: [item()] });
    await reconcileDraftAssets(services, dto.id);
    await runDueGenerationWork(services);
    const before = await assetLink(dto.id, 0, "target_audio");
    expect((await assetRow(before.asset_id!)).state).toBe("ready");

    await editDraft(services, dto.id, {
      items: [{ ...item({ source: "piątek", target: "Friday" }), id: dto.items[0]!.id }],
      expectedEditNumber: 1,
    });

    const after = await assetLink(dto.id, 0, "target_audio");
    expect(after.asset_id).not.toBe(before.asset_id);
    expect(after.expected_fingerprint).not.toBe(before.expected_fingerprint);
    expect((await assetRow(after.asset_id!)).state).toBe("pending");
    expect((await assetRow(before.asset_id!)).state).toBe("ready");

    const runs = await query<{ state: string }>(
      "select state from learning_app.generation_runs where kind = 'tts'",
    );
    expect(runs.map((r) => r.state).sort()).toEqual(["queued", "succeeded"]);
  });

  it("zmiana samego tytułu nie unieważnia zadań audio", async () => {
    const fakes = await fakeGeneration();
    disposers.push(fakes.dispose);
    const services = mediaServices(fakes);

    const dto = await createDraft(services, { title: "Dni", items: [item()] });
    await reconcileDraftAssets(services, dto.id);
    const before = await assetLink(dto.id, 0, "target_audio");

    await editDraft(services, dto.id, { title: "Dni tygodnia", expectedEditNumber: 1 });

    const after = await assetLink(dto.id, 0, "target_audio");
    expect(after).toEqual(before);
    expect(await countRows("media_assets")).toBe(1);
    expect(await countRows("generation_runs")).toBe(1);
  });

  it("usunięcie przykładu i przejście na kolor usuwa zbędne role zasobów", async () => {
    const fakes = await fakeGeneration();
    disposers.push(fakes.dispose);
    const services = mediaServices(fakes);

    const dto = await createDraft(services, {
      title: "Dni",
      items: [item({ visualType: "image", example: "See you on Thursday." })],
    });
    await reconcileDraftAssets(services, dto.id);
    const roles = await query<{ role: string }>(
      "select role from learning_app.revision_assets where item_revision_id = $1 order by role",
      [dto.items[0]!.revisionId],
    );
    expect(roles.map((r) => r.role)).toEqual(["example_audio", "illustration", "target_audio"]);

    await editDraft(services, dto.id, {
      items: [{ ...item({ visualType: "color", visualData: { color: "#4169e1" } }), id: dto.items[0]!.id }],
      expectedEditNumber: 1,
    });

    const remaining = await query<{ role: string }>(
      "select role from learning_app.revision_assets where item_revision_id = $1",
      [dto.items[0]!.revisionId],
    );
    expect(remaining.map((r) => r.role)).toEqual(["target_audio"]);
    // globalny zasób pozostaje w cache
    expect(await countRows("media_assets")).toBe(3);
  });
});
