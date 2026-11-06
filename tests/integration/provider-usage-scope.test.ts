import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  completePresentation,
  createChild,
  createDraft,
  createDrizzleUsageRecorder,
  createLesson,
  createServices,
  dictateLessonAnswer,
  editDraft,
  editLessonDraft,
  endSession,
  enqueueDeckGeneration,
  FakeAnswerGrader,
  FakeDictationSttProvider,
  FakePronunciationProvider,
  FakeSessionActivityReviewer,
  FakeSttProvider,
  fakeLessonSpeechDeps,
  fakeSessionActivityDeps,
  generateDeckCover,
  nextTask,
  prepareUiAudio,
  publishDraft,
  readGeneration,
  readSessionActivityResult,
  reconcileDraftAssets,
  regenerateLessonCardAudio,
  regenerateLessonPromptAudio,
  regenerateLessonStoryAudio,
  regenerateRevisionAsset,
  runDueGenerationWork,
  submitAttempt,
  submitSpeechAttempt,
  upsertAssignment,
  type Services,
} from "@learning/server";
import type { SessionActivityReport, TaskDto, VocabularyItemInput } from "@learning/contracts";
import { ManualClock, startLegacyTrainingSession, testDatabase, truncateCoreTables } from "./helpers";
import { fakeGeneration, recordingProvider, type FakeGeneration } from "./fakes";
import {
  publishAssignedSpiderLesson, seedSchoolDraft, SPIDER_OBJECTIVE, spiderExercises, truncateLessonAudioTables,
} from "./school-lesson-audio-helpers";

/**
 * Zakres kosztów w punktach wejścia (spec 2026-11-02-llm-cost-tracking §4.1, §5)
 * na prawdziwym recorderze Drizzle. Fake-providery opakowuje `recordingProvider`,
 * który zapisuje zdarzenie przy każdym wywołaniu płatnej metody.
 *
 * Co dowodzi ten plik: przypadki użycia (worker generacji, uzgodnienia mediów,
 * okładka, grader, dyktowanie, mowa, ocena aktywności) ustawiają zakres wokół
 * wywołania providera, zakres przechodzi przez `await` do recordera, a wiersz
 * dostaje właściwe przypisanie (run, talia, sesja, dziecko); runy mediów niosą
 * talię, która je zleciła. Czego NIE dowodzi: że prawdziwe adaptery wołają
 * `record` we właściwym miejscu (testy adapterów, zadania 4–5) ani że procesy web
 * i worker składają recorder (testy kompozycji w apps/).
 */

const { db, pool } = testDatabase();
const clock = new ManualClock("2026-11-02T10:00:00.000Z");
const recorder = createDrizzleUsageRecorder({ db, clock, prices: {} });
const disposers: Array<() => Promise<void>> = [];

beforeEach(async () => {
  await truncateCoreTables();
  await truncateLessonAudioTables();
  await pool.query("truncate learning_app.provider_usage_events, learning_app.lesson_verdicts cascade");
});
// Zaległy insert nie może wpaść do następnego testu (truncate w beforeEach).
afterEach(async () => {
  await recorder.flush();
  for (const dispose of disposers.splice(0)) await dispose();
});
afterAll(async () => {
  // Seed z migracji (singleton) musi przetrwać plik: inne pliki robią na nim UPDATE.
  const settings = await pool.query("select count(*)::int as count from learning_app.family_settings");
  expect(settings.rows[0].count).toBe(1);
  await pool.end();
});

interface UsageRow {
  feature: string;
  scope_kind: string;
  generation_run_id: string | null;
  deck_id: string | null;
  session_id: string | null;
  child_id: string | null;
}

async function usageRows(where = "true", params: unknown[] = []): Promise<UsageRow[]> {
  await recorder.flush();
  return (await pool.query<UsageRow>(
    `select feature, scope_kind, generation_run_id, deck_id, session_id, child_id
       from learning_app.provider_usage_events where ${where} order by occurred_at, id`,
    params,
  )).rows;
}

/** Wiersze kosztu runu mediów zasobu (jeden run na zasób — `one_run_per_asset`). */
async function usageOfAsset(assetId: string): Promise<UsageRow[]> {
  return usageRows("generation_run_id = (select id from learning_app.generation_runs where asset_id = $1)", [assetId]);
}

/**
 * Generacja z fake'ami zapisującymi koszt; okładka ma osobny fake obrazu. Fake agenta puli lekcji zapisuje
 * koszt sam (`usage`, jak adapter: jeden wpis na krok, operacje `agent_objective`/`agent_plan`).
 */
async function generationServices(): Promise<{ services: Services; fakes: FakeGeneration }> {
  const fakes = await fakeGeneration({ agent: { generate: {}, usage: recorder } });
  disposers.push(fakes.dispose);
  const services = createServices({
    db,
    clock,
    media: fakes.settings,
    mediaStore: fakes.store,
    generation: {
      ...fakes.deps,
      llm: recordingProvider(fakes.llm, recorder, "deck_generation"),
      tts: recordingProvider(fakes.tts, recorder, "tts"),
      image: recordingProvider(fakes.image, recorder, "illustration"),
    },
    imageProvider: recordingProvider(fakes.image, recorder, "deck_cover"),
    usage: recorder,
  });
  return { services, fakes };
}

/** Przeloty workera aż do wyczerpania zleconej pracy. */
async function drain(services: Services): Promise<void> {
  for (let pass = 0; pass < 40; pass++) {
    const { processed } = await runDueGenerationWork(services, { total: 4, deck: 2, lesson: 2, tts: 4, images: 2 });
    if (processed === 0) return;
  }
  throw new Error("worker nie wyczerpał kolejki");
}

function vocab(source: string, target: string): VocabularyItemInput {
  return { source, target, acceptedAnswers: [], locales: { source: "pl-PL", target: "en-GB" }, visualType: "none" };
}

async function linkedAsset(versionId: string, role: string): Promise<string> {
  return (await pool.query<{ assetId: string }>(
    `select ra.asset_id as "assetId" from learning_app.revision_assets ra
       join learning_app.item_revisions ir on ir.id = ra.item_revision_id
      where ir.deck_version_id = $1 and ra.role = $2 order by ir.position limit 1`,
    [versionId, role],
  )).rows[0]!.assetId;
}

async function editNumberOf(versionId: string): Promise<number> {
  return (await pool.query<{ editNumber: number }>(
    'select edit_number as "editNumber" from learning_app.deck_versions where id = $1', [versionId],
  )).rows[0]!.editNumber;
}

describe("zakres kosztów materiałów", () => {
  it("deck and lesson runs bill their deck", async () => {
    const { services } = await generationServices();
    const deck = await enqueueDeckGeneration(services, { prompt: "Dni tygodnia po angielsku.", idempotencyKey: randomUUID() });
    const lesson = await createLesson(services, {
      subjectId: "english_grammar",
      topicId: "present_simple",
      objectiveIds: ["english_grammar.present_simple.third_person_s"],
      material: "He plays football. She watches TV. They study English every day.",
      poolSize: 20,
      clientRequestId: randomUUID(),
    });

    await drain(services);

    for (const { runId, deckId } of [deck, lesson]) {
      const rows = await usageRows("generation_run_id = $1", [runId]);
      expect(rows.length, runId).toBeGreaterThan(0);
      for (const row of rows) expect(row).toMatchObject({ scope_kind: "run", generation_run_id: runId, deck_id: deckId });
    }
    // Koszt runu lekcji pochodzi z kroków agenta puli (generator lekcji).
    const lessonOperations = (await pool.query<{ feature: string; operation: string | null }>(
      "select distinct feature, operation from learning_app.provider_usage_events where generation_run_id = $1", [lesson.runId],
    )).rows;
    expect(lessonOperations).toContainEqual({ feature: "lesson_generation", operation: "agent_objective" });
    // Media zestawu i lekcji (lektor, ilustracje) też niosą talię, która je zleciła.
    const all = await usageRows();
    expect(all.some((row) => row.feature === "tts")).toBe(true);
    for (const row of all) {
      expect(row.scope_kind).toBe("run");
      expect([deck.deckId, lesson.deckId]).toContain(row.deck_id);
    }
  });

  it("media cost follows origin deck after edit and regeneration", async () => {
    const { services } = await generationServices();
    const a = await createDraft(services, { title: "A", items: [vocab("czwartek", "Thursday")] });
    await reconcileDraftAssets(services, a.id);
    const first = await linkedAsset(a.id, "target_audio");
    // Talia B współdzieli nagranie: zasób jest opłacony raz i przypisany talii A.
    const b = await createDraft(services, { title: "B", items: [vocab("czwartek", "Thursday")] });
    await reconcileDraftAssets(services, b.id);
    expect(await linkedAsset(b.id, "target_audio")).toBe(first);
    await drain(services);
    expect(await usageRows()).toEqual([expect.objectContaining({ feature: "tts", scope_kind: "run", deck_id: a.deckId })]);

    await reconcileDraftAssets(services, b.id);
    await drain(services);
    expect(await usageRows()).toHaveLength(1);

    const edited = await editDraft(services, a.id, { items: [{ ...vocab("piątek", "Friday"), id: a.items[0]!.id }], expectedEditNumber: 1 });
    const second = await linkedAsset(a.id, "target_audio");
    expect(second).not.toBe(first);
    await drain(services);
    expect(await usageOfAsset(second)).toEqual([expect.objectContaining({ feature: "tts", scope_kind: "run", deck_id: a.deckId })]);

    const regenerated = await regenerateRevisionAsset(services, {
      draftId: a.id, itemRevisionId: edited.items[0]!.revisionId, role: "target_audio",
    });
    await drain(services);
    expect(await usageOfAsset(regenerated.assetId)).toEqual([expect.objectContaining({ feature: "tts", scope_kind: "run", deck_id: a.deckId })]);
  });

  it("lesson recordings regenerated by the parent bill the lesson deck", async () => {
    const { services } = await generationServices();
    const school = await seedSchoolDraft(
      [{ id: SPIDER_OBJECTIVE, titlePl: "Pająki", descriptionEn: "Spiders.", cards: [{ title: "Pająki", body: "Pająk ma osiem nóg." }] }],
    );
    await editLessonDraft(services, school.versionId, { expectedEditNumber: 1, exercises: spiderExercises() });
    await drain(services);
    const promptRevision = (await pool.query<{ id: string }>(
      `select ir.id from learning_app.revision_assets ra
         join learning_app.item_revisions ir on ir.id = ra.item_revision_id
        where ir.deck_version_id = $1 and ra.role = 'prompt_audio' order by ir.position limit 1`,
      [school.versionId],
    )).rows[0]!.id;

    const prompt = await regenerateLessonPromptAudio(services, { lessonDraftId: school.versionId, itemRevisionId: promptRevision });
    const card = await regenerateLessonCardAudio(services, { lessonDraftId: school.versionId, objectiveId: SPIDER_OBJECTIVE, cardIndex: 0 });
    await drain(services);
    for (const assetId of [prompt.assetId, card.assetId]) {
      expect(await usageOfAsset(assetId), assetId).toEqual([expect.objectContaining({ feature: "tts", scope_kind: "run", deck_id: school.deckId })]);
    }

    const grammar = await createLesson(services, {
      subjectId: "english_grammar",
      topicId: "present_simple",
      objectiveIds: ["english_grammar.present_simple.third_person_s"],
      material: "He plays football. She watches TV. They study English every day.",
      poolSize: 20,
      clientRequestId: randomUUID(),
    });
    await drain(services);
    const versionId = (await readGeneration(services, grammar.runId)).deckVersionId!;
    await editLessonDraft(services, versionId, {
      expectedEditNumber: await editNumberOf(versionId),
      story: {
        sentences: ["Tom has a small dog.", "The dog is brown and fast.", "Every morning they run in the park.", "Tom loves his dog."],
        questions: [{
          id: "q1",
          question: "Jaki jest pies Toma?",
          options: [{ id: "a", text: "brązowy" }, { id: "b", text: "biały" }, { id: "c", text: "czarny" }],
          correctOption: "a",
        }],
      },
    });
    await drain(services);
    const story = await regenerateLessonStoryAudio(services, { lessonDraftId: versionId });
    await drain(services);
    expect(await usageOfAsset(story.assetId)).toEqual([expect.objectContaining({ feature: "tts", scope_kind: "run", deck_id: grammar.deckId })]);
  });

  it("ui voice runs have a run but no deck", async () => {
    const { services } = await generationServices();
    await prepareUiAudio(services);
    await drain(services);

    const rows = await usageRows();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row).toMatchObject({ feature: "tts", scope_kind: "run", deck_id: null });
      expect(row.generation_run_id).not.toBeNull();
    }
  });

  it("deck cover bills the deck", async () => {
    const { services } = await generationServices();
    const draft = await createDraft(services, { title: "Okładka", items: [vocab("czwartek", "Thursday")] });

    await generateDeckCover(services, draft.deckId);

    expect(await usageRows()).toEqual([{
      feature: "deck_cover", scope_kind: "deck", generation_run_id: null, deck_id: draft.deckId, session_id: null, child_id: null,
    }]);
  });

  it("call outside any scope is unattributed", async () => {
    const { fakes } = await generationServices();
    const image = recordingProvider(fakes.image, recorder, "illustration");

    await image.generate({ prompt: "A cat", ...fakes.settings.image });

    expect(await usageRows()).toEqual([{
      feature: "illustration", scope_kind: "none", generation_run_id: null, deck_id: null, session_id: null, child_id: null,
    }]);
  });
});

/** WAV PCM 16 kHz mono o zadanej długości — w pamięci, bez pliku. */
function wav(seconds: number): { bytes: Uint8Array; mimeType: string; locale: string } {
  const dataBytes = Math.round(seconds * 16_000) * 2;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => [...text].forEach((ch, i) => view.setUint8(offset + i, ch.charCodeAt(0)));
  ascii(0, "RIFF"); view.setUint32(4, 36 + dataBytes, true); ascii(8, "WAVE"); ascii(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true); view.setUint32(28, 32_000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  ascii(36, "data"); view.setUint32(40, dataBytes, true);
  return { bytes, mimeType: "audio/wav", locale: "en-GB" };
}

async function answerKeyOf(taskId: string): Promise<Record<string, unknown>> {
  return (await pool.query<{ answerKey: Record<string, unknown> }>(
    'select answer_key as "answerKey" from learning_app.session_tasks where id = $1', [taskId],
  )).rows[0]!.answerKey;
}

/** Zadanie otwarte lekcji o pająkach w treningu z mikrofonem (należne sprawdzenie celu). */
async function reachOpenTask(services: Services, childId: string, deckId: string): Promise<{ sessionId: string; task: TaskDto }> {
  await pool.query(
    `insert into learning_app.child_objective_progress
       (child_id, subject_id, objective_id, topic_id, status, streak, next_review_at, projection_version)
     values ($1, 'school', $2, 'dynamic', 'needs_confirmation', 3, '2000-01-01T00:00:00Z', 'proj-1')`,
    [childId, SPIDER_OBJECTIVE],
  );
  const session = await startLegacyTrainingSession(services, { childId, deckId, microphoneEnabled: true });
  for (let i = 0; i < 40; i++) {
    const task = await nextTask(services, session.sessionId);
    if (task === null) break;
    if (task.exerciseType === "lesson_open_answer") return { sessionId: session.sessionId, task };
    if (task.exerciseType === "lesson_card") {
      await completePresentation(services, { taskId: task.taskId });
      continue;
    }
    const key = await answerKeyOf(task.taskId);
    if (task.exerciseType === "lesson_choice") {
      await submitAttempt(services, { taskId: task.taskId, clientAttemptId: randomUUID(), modality: "choice", optionId: key.correctOptionId as string });
    } else {
      await submitAttempt(services, { taskId: task.taskId, clientAttemptId: randomUUID(), modality: "text", text: key.answer as string });
    }
  }
  throw new Error("open task not reached");
}

/** Zestaw słówek z gotowym nagraniem, przypisany dziecku (publikacja bez ustawień mediów nie uzgadnia nagrań). */
async function publishVocabulary(childId: string): Promise<{ deckId: string; versionId: string }> {
  const services = createServices({ db, clock });
  const draft = await createDraft(services, { title: "Mowa", items: [{ ...vocab("czwartek", "Thursday"), visualType: "color", visualData: { color: "#4169e1" } }] });
  const revisionId = draft.items[0]!.revisionId;
  const assetId = randomUUID();
  const fingerprint = `fp-${randomUUID()}`;
  await pool.query(
    `insert into learning_app.media_assets
       (id, kind, fingerprint, generation_number, state, storage_key, content_sha256, mime_type, byte_count, provider, model)
     values ($1,'tts',$2,1,'ready',$3,$4,'audio/mpeg',1024,'fake','fake-tts')`,
    [assetId, fingerprint, `blob/${assetId}`, `sha-${assetId}`],
  );
  await pool.query(
    `insert into learning_app.revision_assets (item_revision_id, role, asset_id, expected_fingerprint, state)
     values ($1,'target_audio',$2,$3,'approved'), ($1,'illustration',null,$4,'omitted')`,
    [revisionId, assetId, fingerprint, `fp-ill-${randomUUID()}`],
  );
  await publishDraft(services, draft.id, 1);
  await upsertAssignment(services, childId, draft.deckId, null);
  return { deckId: draft.deckId, versionId: draft.id };
}

/** Sesja z mikrofonem, której pierwsze zadanie to należne Recall jedynego słówka. */
async function recallSession(services: Services, childId: string, versionId: string, deckId: string): Promise<{ sessionId: string; task: TaskDto }> {
  const skillVersions = (await pool.query<{ id: string }>(
    `select s.skill_version_id as id from learning_app.item_revision_skills s
       join learning_app.item_revisions ir on ir.id = s.item_revision_id
      where ir.deck_version_id = $1 and s.skill = 'recall'`,
    [versionId],
  )).rows;
  for (const { id } of skillVersions) {
    await pool.query(
      `insert into learning_app.child_skill_progress
         (child_id, skill_version_id, policy_id, status, independent_success_streak, next_review_at, last_reviewed_at, first_issued_at, has_qualifying_assessment, projection_version)
       select $1,$2,coalesce(c.policy_id, 'learning-v2'),'needs_confirmation',3,'2026-10-01T00:00:00Z','2026-10-01T00:00:00Z',null,false,'proj-3'
         from learning_app.child_profiles c where c.id = $1`,
      [childId, id],
    );
  }
  const session = await startLegacyTrainingSession(services, { childId, deckId, microphoneEnabled: true });
  const task = (await nextTask(services, session.sessionId))!;
  expect(task.exerciseType).toBe("recall");
  return { sessionId: session.sessionId, task };
}

function activityReport(taskId: string, exerciseType: string, attemptId: string): SessionActivityReport {
  return {
    version: 1,
    elapsedMs: 5_000,
    activeMs: 4_000,
    compacted: false,
    tasks: [{
      taskId,
      exerciseType,
      shownFromMs: 0,
      shownToMs: 5_000,
      activeIntervals: [[0, 4_000]],
      editCount: 0,
      editWindows: [],
      submittedAttempts: [attemptId],
      playbacks: [],
      pauses: [],
    }],
  };
}

describe("zakres kosztów nauki", () => {
  it("grader and dictation bill the session and the child", async () => {
    const draft = await seedSchoolDraft(
      [{ id: SPIDER_OBJECTIVE, titlePl: "Pająki", descriptionEn: "Spiders.", cards: [{ title: "Pająki", body: "Pająk ma osiem nóg." }] }],
    );
    const { child, deckId } = await publishAssignedSpiderLesson(draft, "Ola");
    const services = createServices({
      db,
      clock,
      grader: { provider: recordingProvider(new FakeAnswerGrader(), recorder, "answer_grading"), maxCallsPerSession: 20, timeoutMs: 8_000 },
      lessonSpeech: fakeLessonSpeechDeps(recordingProvider(new FakeDictationSttProvider(), recorder, "lesson_stt")),
      usage: recorder,
    });
    const { sessionId, task } = await reachOpenTask(services, child.id, deckId);

    await dictateLessonAnswer(services, { taskId: task.taskId }, wav(2));
    // Odpowiedź niedopasowana deterministycznie trafia do modelu oceniającego.
    await submitAttempt(services, { taskId: task.taskId, clientAttemptId: randomUUID(), modality: "text", text: "Nie wiem, coś o motylach." });

    const rows = await usageRows();
    expect(rows.map((row) => row.feature).sort()).toEqual(["answer_grading", "lesson_stt"]);
    for (const row of rows) {
      expect(row).toMatchObject({ scope_kind: "session", session_id: sessionId, child_id: child.id, generation_run_id: null, deck_id: null });
    }
  });

  it("speech attempt and activity review bill the session and the child", async () => {
    const services = createServices({
      db,
      clock,
      media: {
        tts: { provider: "fake", model: "fake-tts", voice: "test", format: "mp3" },
        image: { provider: "fake", model: "fake-image", size: "small", quality: "low", format: "svg" },
      },
      speech: {
        stt: recordingProvider(new FakeSttProvider(), recorder, "speech_stt"),
        pronunciation: recordingProvider(new FakePronunciationProvider(), recorder, "pronunciation"),
      },
      sessionActivity: fakeSessionActivityDeps({ provider: recordingProvider(new FakeSessionActivityReviewer(), recorder, "session_activity_review") }),
      usage: recorder,
    });
    const child = await createChild(services, { displayName: "Ola", avatarKey: "fox" });
    const { deckId, versionId } = await publishVocabulary(child.id);
    const { sessionId, task } = await recallSession(services, child.id, versionId, deckId);

    const attempt = await submitSpeechAttempt(services, { taskId: task.taskId, clientAttemptId: randomUUID() }, wav(1));
    expect((await usageRows()).map((row) => row.feature)).toContain("speech_stt");

    // Ocena aktywności biegnie poza odpowiedzią (fire-and-forget); czekamy na zapisany wynik.
    await endSession(services, sessionId, activityReport(task.taskId, task.exerciseType, attempt.attemptId));
    for (let i = 0; i < 100; i++) {
      const result = await readSessionActivityResult(services, sessionId);
      if (result !== null && result.status !== "already_started") break;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }

    const rows = await usageRows();
    expect(rows.map((row) => row.feature)).toContain("session_activity_review");
    for (const row of rows) {
      expect(row).toMatchObject({ scope_kind: "session", session_id: sessionId, child_id: child.id, generation_run_id: null, deck_id: null });
    }
  });
});
