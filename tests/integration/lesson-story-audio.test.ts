import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createLesson,
  createLessonDraftFromPublished,
  createServices,
  createSubjectRegistry,
  editLessonDraft,
  englishGrammarSubject,
  executeLessonGeneration,
  executeMediaAsset,
  publishLessonDraft,
  readGeneration,
  readLessonDeck,
  regenerateLessonStoryAudio,
  runDueGenerationWork,
  schoolSubject,
  type Services,
} from "@learning/server";
import type { LessonCommand } from "@learning/contracts";
import { ManualClock, testDatabase, truncateCoreTables } from "./helpers";
import { fakeGeneration, type FakeGeneration } from "./fakes";
import {
  addGeneration, EN_LANGUAGE_INSTRUCTION, generationsOf, markTtsReady, mediaAsset, PL_LANGUAGE_INSTRUCTION, seedSchoolDraft, truncateLessonAudioTables,
} from "./school-lesson-audio-helpers";
import { storyReadText } from "../../packages/server/src/domain/lessons/story";

/**
 * Nagranie lektora historyjki lekcji (design „Historyjka lekcji” §7) na
 * PostgreSQL: edycja szkicu z historyjką wiąże jedno nagranie w
 * `lesson_story_assets` (zdania, locale odpowiedzi, bez stylu wypowiedzi),
 * zmiana zdań wiąże nowe, zmiana samych pytań zostawia je, usunięcie
 * historyjki usuwa wiersz, a wynik runu historyjki wiąże nagranie bez
 * uruchamiania workera. Publikacja na nagranie nie czeka i ponawia nieudane;
 * wiersz opublikowanej wersji jest niezmienny, a kopia wersji od razu pokazuje
 * to samo gotowe nagranie bez nowego zlecenia TTS.
 */

const { db, pool } = testDatabase();
const OBJECTIVE = "english_grammar.present_simple.third_person_s";

/** Poprawna historyjka rodzica (zdania spoza puli fake: materiał to „He plays football…”). */
const STORY = {
  sentences: ["Tom has a small dog.", "The dog is brown and fast.", "Every morning they run in the park.", "Tom loves his dog."],
  questions: [
    {
      id: "q1",
      question: "Jaki jest pies Toma?",
      options: [
        { id: "a", text: "brązowy" },
        { id: "b", text: "biały" },
        { id: "c", text: "czarny" },
      ],
      correctOption: "a",
    },
  ],
};

const disposers: Array<() => Promise<void>> = [];

beforeEach(async () => {
  await truncateCoreTables();
  await truncateLessonAudioTables();
});
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});
afterAll(() => pool.end());

/**
 * Usługi lekcji gramatyki: `media` i `generation` mają tego samego providera i
 * model TTS (inaczej zasoby zostałyby pominięte jako obce). `styled` dodaje styl
 * wypowiedzi i instrukcje języka pl-PL oraz en-GB.
 */
function grammarServices(
  fakes: FakeGeneration,
  options: { styled?: boolean; subjects?: Parameters<typeof createSubjectRegistry>[0] } = {},
): Services {
  const media = options.styled
    ? {
        ...fakes.settings,
        tts: {
          ...fakes.settings.tts,
          style: "instructions" as const,
          instructions: { "pl-PL": PL_LANGUAGE_INSTRUCTION, "en-GB": EN_LANGUAGE_INSTRUCTION },
        },
      }
    : fakes.settings;
  return createServices({
    db,
    clock: new ManualClock(),
    media,
    generation: fakes.deps,
    subjects: createSubjectRegistry(options.subjects ?? [englishGrammarSubject, schoolSubject]),
  });
}

function command(): LessonCommand {
  return {
    subjectId: "english_grammar",
    topicId: "present_simple",
    objectiveIds: [OBJECTIVE],
    material: "He plays football. She watches TV. They study English every day.",
    poolSize: 20,
    clientRequestId: randomUUID(),
  };
}

async function grammarDraft(options: { styled?: boolean } = {}) {
  const fakes = await fakeGeneration();
  disposers.push(fakes.dispose);
  const services = grammarServices(fakes, options);
  const { runId, deckId } = await createLesson(services, command());
  await executeLessonGeneration(services, runId);
  const versionId = (await readGeneration(services, runId)).deckVersionId!;
  const storyRun = (await pool.query<{ id: string }>(
    "select id from learning_app.generation_runs where deck_version_id = $1 and input->>'purpose' = 'story'",
    [versionId],
  )).rows[0]!;
  return { fakes, services, deckId, versionId, storyRunId: storyRun.id };
}

interface StoryAssetRow {
  assetId: string;
  expectedFingerprint: string;
  fingerprint: string;
  state: string;
  generationNumber: number;
  text: string;
  locale: string;
  instructions: string | null;
}

async function storyAssets(versionId: string): Promise<StoryAssetRow[]> {
  return (await pool.query<StoryAssetRow>(
    `select sa.asset_id as "assetId", sa.expected_fingerprint as "expectedFingerprint", ma.fingerprint, ma.state,
            ma.generation_number as "generationNumber", ma.metadata->>'text' as text, ma.metadata->>'locale' as locale,
            ma.metadata->>'instructions' as instructions
       from learning_app.lesson_story_assets sa
       join learning_app.media_assets ma on ma.id = sa.asset_id
      where sa.deck_version_id = $1`,
    [versionId],
  )).rows;
}

/**
 * Edycja szkicu z bieżącym `edit_number` odczytanym z bazy, więc test nie zależy
 * od liczby zapisów wykonanych wcześniej (generacja, run historyjki, edycje).
 */
async function edit(services: Services, versionId: string, patch: Omit<Parameters<typeof editLessonDraft>[2], "expectedEditNumber">) {
  const { editNumber } = (await pool.query<{ editNumber: number }>(
    'select edit_number as "editNumber" from learning_app.deck_versions where id = $1',
    [versionId],
  )).rows[0]!;
  return editLessonDraft(services, versionId, { ...patch, expectedEditNumber: editNumber });
}

async function runStatesOf(assetId: string): Promise<string[]> {
  return (await pool.query<{ state: string }>("select state from learning_app.generation_runs where asset_id = $1 order by created_at", [assetId]))
    .rows.map((row) => row.state);
}

async function ttsRunCount(): Promise<number> {
  return (await pool.query<{ count: number }>("select count(*)::int as count from learning_app.generation_runs where kind = 'tts'")).rows[0]!.count;
}

describe("nagranie historyjki lekcji (integracja)", () => {
  it("edit with a story creates one story recording in en-GB without speaking style", async () => {
    const { services, versionId } = await grammarDraft({ styled: true });
    expect(await storyAssets(versionId)).toEqual([]);

    await edit(services, versionId, { story: STORY });

    const rows = await storyAssets(versionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ text: storyReadText(STORY), locale: "en-GB", state: "pending" });
    expect(rows[0]!.expectedFingerprint).toBe(rows[0]!.fingerprint);
    // Tylko instrukcja języka en-GB: bez zdania stylu i bez instrukcji pl-PL.
    expect(rows[0]!.instructions).toBe(EN_LANGUAGE_INSTRUCTION);
  });

  it("changing story sentences binds a new recording, changing only questions keeps it", async () => {
    const { services, versionId } = await grammarDraft();
    await edit(services, versionId, { story: STORY });
    const [first] = await storyAssets(versionId);

    // Zmienione pytanie, zdania bez zmian: to samo nagranie.
    const questionsOnly = { ...STORY, questions: [{ ...STORY.questions[0]!, question: "Jakiego koloru jest pies Toma?" }] };
    await edit(services, versionId, { story: questionsOnly });
    const afterQuestions = await storyAssets(versionId);
    expect(afterQuestions).toHaveLength(1);
    expect(afterQuestions[0]!.assetId).toBe(first!.assetId);

    // Inne zdanie: nowy zasób o nowym fingerprincie.
    const otherSentences = { ...STORY, sentences: ["Tom has a small cat.", ...STORY.sentences.slice(1)] };
    await edit(services, versionId, { story: otherSentences });
    const afterSentences = await storyAssets(versionId);
    expect(afterSentences).toHaveLength(1);
    expect(afterSentences[0]!.assetId).not.toBe(first!.assetId);
    expect(afterSentences[0]!.fingerprint).not.toBe(first!.fingerprint);
    expect(afterSentences[0]!.text).toBe(storyReadText(otherSentences));
  });

  it("removing the story deletes its recording row", async () => {
    const { services, versionId } = await grammarDraft();
    await edit(services, versionId, { story: STORY });
    expect(await storyAssets(versionId)).toHaveLength(1);

    await edit(services, versionId, { story: null });

    expect((await pool.query("select 1 from learning_app.lesson_story_assets where deck_version_id = $1", [versionId])).rowCount).toBe(0);
  });

  it("successful story run binds the recording", async () => {
    const { fakes, services, versionId, storyRunId } = await grammarDraft();
    expect(await storyAssets(versionId)).toEqual([]);

    await executeLessonGeneration(services, storyRunId);

    expect((await readGeneration(services, storyRunId)).state).toBe("succeeded");
    const story = (await pool.query<{ story: { sentences: string[]; questions: [] } }>(
      "select lesson_context->'story' as story from learning_app.deck_versions where id = $1",
      [versionId],
    )).rows[0]!.story;
    const rows = await storyAssets(versionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: "pending", locale: "en-GB", text: storyReadText(story) });
    // Worker jeszcze nie ruszył: nagranie czeka w kolejce.
    expect(fakes.tts.requests).toHaveLength(0);
  });

  it("failed story recording is queued again on publish and publish does not wait for it", async () => {
    const { services, deckId, versionId } = await grammarDraft();
    await edit(services, versionId, { story: STORY });
    const [first] = await storyAssets(versionId);
    await pool.query("update learning_app.media_assets set state = 'failed' where id = $1", [first!.assetId]);

    const draft = (await readLessonDeck(services, deckId)).draft!;
    await publishLessonDraft(services, versionId, draft.editNumber);

    expect((await readLessonDeck(services, deckId)).state).toBe("published");
    const rows = await storyAssets(versionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.assetId).not.toBe(first!.assetId);
    expect(rows[0]).toMatchObject({ state: "pending", generationNumber: 2, fingerprint: first!.fingerprint });
  });

  it("published version story recording row is immutable", async () => {
    const { services, deckId, versionId } = await grammarDraft();
    await edit(services, versionId, { story: STORY });
    const [row] = await storyAssets(versionId);
    const draft = (await readLessonDeck(services, deckId)).draft!;
    await publishLessonDraft(services, versionId, draft.editNumber);
    const immutable = /Published lesson story asset is immutable/;

    await expect(pool.query(
      "insert into learning_app.lesson_story_assets (deck_version_id, asset_id, expected_fingerprint) values ($1, $2, $3)",
      [versionId, row!.assetId, "other"],
    )).rejects.toThrow(immutable);
    await expect(pool.query(
      "update learning_app.lesson_story_assets set expected_fingerprint = 'other' where deck_version_id = $1",
      [versionId],
    )).rejects.toThrow(immutable);
    await expect(pool.query("delete from learning_app.lesson_story_assets where deck_version_id = $1", [versionId]))
      .rejects.toThrow(immutable);
    expect(await storyAssets(versionId)).toHaveLength(1);
  });

  it("new version from published shows the shared recording at once", async () => {
    const { services, deckId, versionId } = await grammarDraft();
    await edit(services, versionId, { story: STORY });
    const [published] = await storyAssets(versionId);
    // Zastępuje workera: nagranie historyjki gotowe przed publikacją.
    await markTtsReady(published!.assetId);
    const draft = (await readLessonDeck(services, deckId)).draft!;
    await publishLessonDraft(services, versionId, draft.editNumber);
    const runsBefore = await ttsRunCount();

    const copy = await createLessonDraftFromPublished(services, deckId);

    expect(copy.id).not.toBe(versionId);
    const rows = await storyAssets(copy.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ assetId: published!.assetId, state: "ready" });
    expect(await ttsRunCount()).toBe(runsBefore);
  });

  it("publish without edit binds the story recording of a draft without a row", async () => {
    const { services, deckId, versionId } = await grammarDraft();
    // Historyjka trafia do kontekstu poza edycją (jak lekcja z etapu 1), więc szkic nie ma wiersza nagrania.
    await pool.query(
      "update learning_app.deck_versions set lesson_context = jsonb_set(lesson_context, '{story}', $2::jsonb) where id = $1",
      [versionId, JSON.stringify(STORY)],
    );
    await pool.query("delete from learning_app.lesson_story_assets where deck_version_id = $1", [versionId]);
    expect(await storyAssets(versionId)).toEqual([]);

    const draft = (await readLessonDeck(services, deckId)).draft!;
    await publishLessonDraft(services, versionId, draft.editNumber);

    const rows = await storyAssets(versionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: "pending", locale: "en-GB", text: storyReadText(STORY) });
  });

  it("new version of a stage-1 published lesson without a row gets the recording", async () => {
    const { services, deckId, versionId } = await grammarDraft();
    const edited = await edit(services, versionId, { story: STORY });
    const [first] = await storyAssets(versionId);
    await publishLessonDraft(services, versionId, edited.editNumber);
    // Jedyne ujęcie nieudane, a opublikowana wersja bez wiersza (jak lekcja z etapu 1).
    await pool.query("update learning_app.media_assets set state = 'failed' where fingerprint = $1", [first!.fingerprint]);
    await pool.query("alter table learning_app.lesson_story_assets disable trigger lesson_story_assets_immutable");
    try {
      await pool.query("delete from learning_app.lesson_story_assets where deck_version_id = $1", [versionId]);
    } finally {
      await pool.query("alter table learning_app.lesson_story_assets enable trigger lesson_story_assets_immutable");
    }
    expect(await storyAssets(versionId)).toEqual([]);
    const runsBefore = await ttsRunCount();

    const copy = await createLessonDraftFromPublished(services, deckId);

    const rows = await storyAssets(copy.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: "pending", fingerprint: first!.fingerprint, text: storyReadText(STORY) });
    expect(await ttsRunCount()).toBeGreaterThan(runsBefore);
    expect(await runStatesOf(rows[0]!.assetId)).toEqual(["queued"]);
  });
});

describe("nagranie historyjki lekcji — worker i stan w szkicu (integracja)", () => {
  /** Worker mediów: pętla jak w `grammar-without-tts.test.ts`, aż nie ma zadań. */
  async function runWorker(worker: Services): Promise<void> {
    for (let pass = 0; pass < 10; pass += 1) {
      const result = await runDueGenerationWork(worker, { lesson: 0, deck: 0, tts: 50, images: 0 });
      if (result.processed === 0) break;
    }
  }

  const readDraft = async (services: Services, deckId: string) => (await readLessonDeck(services, deckId)).draft!;

  it("worker brings the story recording to ready and the draft dto shows it", async () => {
    const { fakes, services, deckId, versionId } = await grammarDraft();
    await edit(services, versionId, { story: STORY });
    const [row] = await storyAssets(versionId);
    expect((await readDraft(services, deckId)).storyAudio).toEqual({ state: "pending" });

    await runWorker(services);

    expect(fakes.tts.requests.map((request) => request.text)).toContain(storyReadText(STORY));
    expect((await storyAssets(versionId))[0]).toMatchObject({ assetId: row!.assetId, state: "ready" });
    expect((await readDraft(services, deckId)).storyAudio).toEqual({ state: "ready", assetId: row!.assetId });
  });

  it("story recording replaced before the worker ran is cancelled and never shown as failed", async () => {
    const { services, deckId, versionId } = await grammarDraft();
    await edit(services, versionId, { story: STORY });
    const [a] = await storyAssets(versionId);
    const other = { ...STORY, sentences: ["Tom has a small cat.", ...STORY.sentences.slice(1)] };
    await edit(services, versionId, { story: other });
    const [b] = await storyAssets(versionId);
    expect(b!.assetId).not.toBe(a!.assetId);

    await runWorker(services);

    expect((await mediaAsset(a!.assetId)).state).toBe("failed");
    expect(await runStatesOf(a!.assetId)).toEqual(["superseded"]);
    expect((await readDraft(services, deckId)).storyAudio).toEqual({ state: "ready", assetId: b!.assetId });

    // Powrót do zdań A: nowa generacja czeka, a anulowany zasób nie jest porażką ani poprzednim ujęciem.
    await edit(services, versionId, { story: STORY });
    const storyAudio = (await readDraft(services, deckId)).storyAudio!;
    expect(storyAudio.state).toBe("pending");
    expect(storyAudio.previousAssetId).toBeUndefined();
  });

  it("worker cancels a story recording referenced only by a subject without lessonStory", async () => {
    const { fakes, services, versionId } = await grammarDraft();
    await edit(services, versionId, { story: STORY });
    const [row] = await storyAssets(versionId);
    // Wiersz zostaje, ale worker zna przedmiot bez flagi `lessonStory`.
    const worker = grammarServices(fakes, { subjects: [{ ...englishGrammarSubject, lessonStory: false }, schoolSubject] });

    await executeMediaAsset(worker, row!.assetId);

    expect((await mediaAsset(row!.assetId)).state).toBe("failed");
    expect(await runStatesOf(row!.assetId)).toEqual(["superseded"]);
    expect(fakes.tts.requests).toHaveLength(0);
  });

  it("worker keeps a shared story recording when another version still has lessonStory", async () => {
    const { fakes, services, versionId } = await grammarDraft();
    await edit(services, versionId, { story: STORY });
    const [row] = await storyAssets(versionId);
    // Druga wersja (przedmiot szkolny, bez `lessonStory`) wiąże to samo nagranie.
    const school = await seedSchoolDraft([{ id: "school.ddeck000.pajaki", titlePl: "Pająki", descriptionEn: "Spiders.", cards: [] }]);
    await pool.query(
      "insert into learning_app.lesson_story_assets (deck_version_id, asset_id, expected_fingerprint) values ($1, $2, $3)",
      [school.versionId, row!.assetId, row!.expectedFingerprint],
    );

    await executeMediaAsset(services, row!.assetId);

    expect((await mediaAsset(row!.assetId)).state).toBe("ready");
    expect(fakes.tts.requests.map((request) => request.text)).toContain(storyReadText(STORY));
  });

  it("regenerate story audio enqueues the next generation and the dto shows pending with previous", async () => {
    const { services, deckId, versionId } = await grammarDraft();
    await edit(services, versionId, { story: STORY });
    const [first] = await storyAssets(versionId);
    await markTtsReady(first!.assetId);

    const { assetId } = await regenerateLessonStoryAudio(services, { lessonDraftId: versionId });

    expect(assetId).not.toBe(first!.assetId);
    expect(await mediaAsset(assetId)).toMatchObject({ state: "pending", generationNumber: 2, fingerprint: first!.fingerprint });
    expect((await storyAssets(versionId))[0]!.assetId).toBe(assetId);
    expect((await readDraft(services, deckId)).storyAudio).toEqual({ state: "pending", previousAssetId: first!.assetId });
  });

  it("regenerate story audio leaves other failed recordings of the draft alone", async () => {
    const { services, versionId } = await grammarDraft();
    await edit(services, versionId, { story: STORY });
    const [story] = await storyAssets(versionId);
    await markTtsReady(story!.assetId);
    const other = (await pool.query<{ assetId: string; fingerprint: string }>(
      `select ra.asset_id as "assetId", ra.expected_fingerprint as fingerprint
         from learning_app.revision_assets ra
         join learning_app.item_revisions ir on ir.id = ra.item_revision_id
        where ir.deck_version_id = $1 and ra.asset_id is not null
        limit 1`,
      [versionId],
    )).rows[0];
    expect(other).toBeDefined();
    await pool.query("update learning_app.media_assets set state = 'failed' where id = $1", [other!.assetId]);

    await regenerateLessonStoryAudio(services, { lessonDraftId: versionId });

    expect(await generationsOf(other!.fingerprint)).toHaveLength(1);
    expect(await generationsOf(story!.fingerprint)).toHaveLength(2);
  });

  it("regenerate story audio twice while pending returns the same asset", async () => {
    const { services, versionId } = await grammarDraft();
    await edit(services, versionId, { story: STORY });
    const [first] = await storyAssets(versionId);
    await markTtsReady(first!.assetId);

    const one = await regenerateLessonStoryAudio(services, { lessonDraftId: versionId });
    const two = await regenerateLessonStoryAudio(services, { lessonDraftId: versionId });

    expect(two.assetId).toBe(one.assetId);
    expect(await generationsOf(first!.fingerprint)).toHaveLength(2);
  });

  it("failed story recording shows failed with the previous ready take", async () => {
    const { services, deckId, versionId } = await grammarDraft();
    await edit(services, versionId, { story: STORY });
    const [first] = await storyAssets(versionId);
    await markTtsReady(first!.assetId);
    await addGeneration(first!.assetId, "failed");

    expect((await readDraft(services, deckId)).storyAudio).toEqual({ state: "failed", previousAssetId: first!.assetId });
  });

  it("regenerate story audio rejects a published version (immutable) and a draft without story (not_found)", async () => {
    const { services, deckId, versionId } = await grammarDraft();
    await expect(regenerateLessonStoryAudio(services, { lessonDraftId: versionId })).rejects.toMatchObject({ code: "not_found" });
    await expect(regenerateLessonStoryAudio(services, { lessonDraftId: randomUUID() })).rejects.toMatchObject({ code: "not_found" });

    const edited = await edit(services, versionId, { story: STORY });
    await publishLessonDraft(services, versionId, edited.editNumber);

    await expect(regenerateLessonStoryAudio(services, { lessonDraftId: versionId })).rejects.toMatchObject({ code: "immutable" });
    expect((await readLessonDeck(services, deckId)).state).toBe("published");
  });

  it("draft without story has no storyAudio", async () => {
    const { services, deckId, versionId } = await grammarDraft();
    expect(await readDraft(services, deckId)).not.toHaveProperty("storyAudio");

    await edit(services, versionId, { story: STORY });
    expect(await readDraft(services, deckId)).toHaveProperty("storyAudio");
    await edit(services, versionId, { story: null });
    expect(await readDraft(services, deckId)).not.toHaveProperty("storyAudio");
  });

  it("regenerate story audio after a TTS config change rebinds the row without a new generation of the old fingerprint", async () => {
    const { fakes, services, versionId } = await grammarDraft();
    await edit(services, versionId, { story: STORY });
    const [row] = await storyAssets(versionId);
    await markTtsReady(row!.assetId);
    const original = await mediaAsset(row!.assetId);
    const switched = createServices({
      db,
      clock: new ManualClock(),
      media: { ...fakes.settings, tts: { ...fakes.settings.tts, provider: "openrouter", model: "openai/gpt-4o-mini-tts-2025-12-15" } },
      generation: fakes.deps,
      subjects: createSubjectRegistry([englishGrammarSubject, schoolSubject]),
    });

    const { assetId } = await regenerateLessonStoryAudio(switched, { lessonDraftId: versionId });

    const fresh = await mediaAsset(assetId);
    expect(fresh).toMatchObject({ state: "pending", provider: "openrouter", model: "openai/gpt-4o-mini-tts-2025-12-15", generationNumber: 1 });
    expect(fresh.fingerprint).not.toBe(original.fingerprint);
    const [rebound] = await storyAssets(versionId);
    expect(rebound).toMatchObject({ assetId, expectedFingerprint: fresh.fingerprint });
    expect(rebound!.expectedFingerprint).not.toBe(row!.expectedFingerprint);
    expect(await generationsOf(original.fingerprint)).toHaveLength(1);
    expect(await mediaAsset(row!.assetId)).toEqual(original);
    // Drugie wywołanie zwraca to samo oczekujące ujęcie nowego fingerprintu.
    expect((await regenerateLessonStoryAudio(switched, { lessonDraftId: versionId })).assetId).toBe(assetId);
    expect(await generationsOf(fresh.fingerprint)).toHaveLength(1);
  });

  it("regenerate story audio without media settings fails with internal", async () => {
    const { services, versionId } = await grammarDraft();
    await edit(services, versionId, { story: STORY });
    const withoutMedia = createServices({ db, clock: new ManualClock(), subjects: createSubjectRegistry([englishGrammarSubject, schoolSubject]) });

    await expect(regenerateLessonStoryAudio(withoutMedia, { lessonDraftId: versionId })).rejects.toMatchObject({ code: "internal" });
  });

  it("published version shows a new take made in the draft through the shared fingerprint", async () => {
    const { services, deckId, versionId } = await grammarDraft();
    const edited = await edit(services, versionId, { story: STORY });
    const [first] = await storyAssets(versionId);
    await markTtsReady(first!.assetId);
    await publishLessonDraft(services, versionId, edited.editNumber);
    expect((await readLessonDeck(services, deckId)).published!.storyAudio).toEqual({ state: "ready", assetId: first!.assetId });

    const copy = await createLessonDraftFromPublished(services, deckId);
    const { assetId } = await regenerateLessonStoryAudio(services, { lessonDraftId: copy.id });

    // Wspólny fingerprint: opublikowana wersja widzi nowe ujęcie ze szkicu (do gotowości — poprzednie).
    expect((await readLessonDeck(services, deckId)).published!.storyAudio).toEqual({ state: "pending", previousAssetId: first!.assetId });
    await markTtsReady(assetId);
    expect((await readLessonDeck(services, deckId)).published!.storyAudio).toEqual({ state: "ready", assetId });
  });
});
