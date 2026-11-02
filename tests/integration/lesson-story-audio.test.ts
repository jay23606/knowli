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
  publishLessonDraft,
  readGeneration,
  readLessonDeck,
  schoolSubject,
  type Services,
} from "@learning/server";
import type { LessonCommand } from "@learning/contracts";
import { ManualClock, testDatabase, truncateCoreTables } from "./helpers";
import { fakeGeneration, type FakeGeneration } from "./fakes";
import { EN_LANGUAGE_INSTRUCTION, markTtsReady, PL_LANGUAGE_INSTRUCTION, truncateLessonAudioTables } from "./school-lesson-audio-helpers";
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
function grammarServices(fakes: FakeGeneration, options: { styled?: boolean } = {}): Services {
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
    subjects: createSubjectRegistry([englishGrammarSubject, schoolSubject]),
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

async function ttsRunCount(): Promise<number> {
  return (await pool.query<{ count: number }>("select count(*)::int as count from learning_app.generation_runs where kind = 'tts'")).rows[0]!.count;
}

describe("nagranie historyjki lekcji (integracja)", () => {
  it("edit with a story creates one story recording in en-GB without speaking style", async () => {
    const { services, versionId } = await grammarDraft({ styled: true });
    expect(await storyAssets(versionId)).toEqual([]);

    await editLessonDraft(services, versionId, { expectedEditNumber: 2, story: STORY });

    const rows = await storyAssets(versionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ text: storyReadText(STORY), locale: "en-GB", state: "pending" });
    expect(rows[0]!.expectedFingerprint).toBe(rows[0]!.fingerprint);
    // Tylko instrukcja języka en-GB: bez zdania stylu i bez instrukcji pl-PL.
    expect(rows[0]!.instructions).toBe(EN_LANGUAGE_INSTRUCTION);
  });

  it("changing story sentences binds a new recording, changing only questions keeps it", async () => {
    const { services, versionId } = await grammarDraft();
    await editLessonDraft(services, versionId, { expectedEditNumber: 2, story: STORY });
    const [first] = await storyAssets(versionId);

    // Zmienione pytanie, zdania bez zmian: to samo nagranie.
    const questionsOnly = { ...STORY, questions: [{ ...STORY.questions[0]!, question: "Jakiego koloru jest pies Toma?" }] };
    await editLessonDraft(services, versionId, { expectedEditNumber: 3, story: questionsOnly });
    const afterQuestions = await storyAssets(versionId);
    expect(afterQuestions).toHaveLength(1);
    expect(afterQuestions[0]!.assetId).toBe(first!.assetId);

    // Inne zdanie: nowy zasób o nowym fingerprincie.
    const otherSentences = { ...STORY, sentences: ["Tom has a small cat.", ...STORY.sentences.slice(1)] };
    await editLessonDraft(services, versionId, { expectedEditNumber: 4, story: otherSentences });
    const afterSentences = await storyAssets(versionId);
    expect(afterSentences).toHaveLength(1);
    expect(afterSentences[0]!.assetId).not.toBe(first!.assetId);
    expect(afterSentences[0]!.fingerprint).not.toBe(first!.fingerprint);
    expect(afterSentences[0]!.text).toBe(storyReadText(otherSentences));
  });

  it("removing the story deletes its recording row", async () => {
    const { services, versionId } = await grammarDraft();
    await editLessonDraft(services, versionId, { expectedEditNumber: 2, story: STORY });
    expect(await storyAssets(versionId)).toHaveLength(1);

    await editLessonDraft(services, versionId, { expectedEditNumber: 3, story: null });

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
    await editLessonDraft(services, versionId, { expectedEditNumber: 2, story: STORY });
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
    await editLessonDraft(services, versionId, { expectedEditNumber: 2, story: STORY });
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
    await editLessonDraft(services, versionId, { expectedEditNumber: 2, story: STORY });
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
});
