import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  authorizeDisclosure, completePresentation, createChild, createLesson, createServices,
  executeLessonGeneration, nextTask, publishLessonDraft, readLessonDeck, startSession, submitAttempt,
  createSubjectRegistry, englishGrammarSubject, runDueGenerationWork, enqueueDeckGeneration, executeGeneration, executeMediaAsset,
  type Services,
} from "@learning/server";
import type { TaskDto } from "@learning/contracts";
import { lessonWorld } from "../fixtures/lesson-world";
import { grammarWithoutSentenceAudio, ManualClock, testDatabase, truncateCoreTables } from "./helpers";
import { fakeGeneration } from "./fakes";

const { db, pool } = testDatabase();
const OBJECTIVE = "english_grammar.present_simple.third_person_s";
const cleanup: Array<() => Promise<void>> = [];

beforeEach(async () => {
  await truncateCoreTables();
  await pool.query(`truncate learning_app.generation_runs, learning_app.revision_assets, learning_app.media_assets,
    learning_app.item_revision_skills, learning_app.item_revisions, learning_app.skill_versions,
    learning_app.learning_items, learning_app.deck_versions, learning_app.decks cascade`);
});
afterEach(async () => { for (const dispose of cleanup.splice(0)) await dispose(); });
afterAll(() => pool.end());

async function generatedLesson(withAudio = false) {
  const fakes = await fakeGeneration();
  cleanup.push(fakes.dispose);
  const services = createServices({ db, clock: new ManualClock(), media: fakes.settings, generation: fakes.deps,
    ...(withAudio ? { subjects: createSubjectRegistry([{ ...englishGrammarSubject, ttsForAnswers: true }]) } : {}),
  });
  const run = await createLesson(services, {
    subjectId: "english_grammar", topicId: "present_simple", objectiveIds: [OBJECTIVE],
    material: "He plays football. She reads books. She watches TV.", poolSize: 20, clientRequestId: randomUUID(),
  });
  await executeLessonGeneration(services, run.runId);
  const draft = (await readLessonDeck(services, run.deckId)).draft!;
  return { services, fakes, run, draft };
}

async function legacyLessonTask(services: Services): Promise<{ childId: string; deckId: string; task: TaskDto }> {
  const child = await createChild(services, { displayName: "Gramatyka", avatarKey: "owl" });
  const world = await lessonWorld(pool, { childId: child.id, richPool: true, withObjectiveAssessment: true, withTargetAudioFor: ["lesson_gap"] });
  const session = await startSession(services, { childId: child.id, deckId: world.deckId, microphoneEnabled: false });
  for (let i = 0; i < 20; i++) {
    const task = await nextTask(services, session.sessionId);
    if (!task) throw new Error("sesja zakończona przed luką");
    if (task.exerciseType === "lesson_gap") return { childId: child.id, deckId: world.deckId, task };
    if (task.exerciseType === "lesson_card") { await completePresentation(services, { taskId: task.taskId }); continue; }
    const key = (await pool.query("select answer_key from learning_app.session_tasks where id=$1", [task.taskId])).rows[0].answer_key;
    await submitAttempt(services, { taskId: task.taskId, clientAttemptId: randomUUID(),
      ...(task.exerciseType === "lesson_order"
        ? { modality: "sequence" as const, itemIds: key.itemIds }
        : { modality: "choice" as const, optionId: key.correctOptionId }),
    });
  }
  throw new Error("nie wydano luki");
}

describe("gramatyka bez TTS", () => {
  it("generacja zapisuje ćwiczenia bez zasobów audio odpowiedzi; zlecone są tylko nagrania zdań feedbacku", async () => {
    const { draft } = await generatedLesson();
    // 20 ćwiczeń podziału etapów + 2 ćwiczenia wyboru ze słuchu (dodatek poza podziałem).
    expect(draft.exercises).toHaveLength(22);
    expect(draft.assets).toEqual([]);
    expect((await pool.query("select count(*)::int as count from learning_app.revision_assets where role <> 'feedback_audio'")).rows[0].count).toBe(0);
    expect((await pool.query("select count(*)::int as count from learning_app.media_assets")).rows[0].count).toBeGreaterThan(0);
    expect((await pool.query("select distinct kind from learning_app.generation_runs order by kind")).rows).toEqual([{ kind: "lesson" }, { kind: "tts" }]);
  });

  it("publikuje kompletną lekcję od razu po generacji tekstu, bez wykonania TTS", async () => {
    const { services, draft } = await generatedLesson();
    expect(draft.coverage).toEqual([]);
    await expect(publishLessonDraft(services, draft.id, draft.editNumber)).resolves.toEqual({ deckVersionId: draft.id });
  });

  it("istniejące audio opublikowanej gramatyki nie trafia do nowego zadania", async () => {
    const services = createServices({ db, clock: new ManualClock() });
    const { task, deckId } = await legacyLessonTask(services);
    expect(task.prompt).not.toHaveProperty("audioAssetId");
    expect((await readLessonDeck(services, deckId)).published?.assets).toEqual([]);
    expect((await pool.query("select count(*)::int as count from learning_app.media_assets where state='ready'")).rows[0].count).toBeGreaterThan(0);
  });

  it("wznowienie starego wydanego zadania ukrywa głośnik bez przepisywania snapshotu", async () => {
    const services = createServices({ db, clock: new ManualClock() });
    const previouslyEnabled = createServices({ db, clock: services.clock,
      subjects: createSubjectRegistry([{ ...englishGrammarSubject, ttsForAnswers: true }]),
    });
    const { task } = await legacyLessonTask(previouslyEnabled);
    const asset = (task.prompt as { audioAssetId?: string }).audioAssetId;
    expect(asset).toBeDefined();
    const resumed = await nextTask(services, task.sessionId);
    expect(resumed?.taskId).toBe(task.taskId);
    expect(resumed?.prompt).not.toHaveProperty("audioAssetId");
    expect((await pool.query("select public_prompt from learning_app.session_tasks where id=$1", [task.taskId])).rows[0].public_prompt.audioAssetId).toBe(asset);
  });

  it("odrzuca odsłuch z dotychczasowego klienta bez zapisania ekspozycji", async () => {
    const services = createServices({ db, clock: new ManualClock() });
    const { childId, task } = await legacyLessonTask(services);
    await expect(authorizeDisclosure(services, { taskId: task.taskId, kind: "audio" })).rejects.toMatchObject({ code: "conflict" });
    expect((await pool.query("select count(*)::int as count from learning_app.learning_events where child_id=$1 and kind='audio_issued'", [childId])).rows[0].count).toBe(0);
  });

  it("worker nie wykonuje wcześniejszych zadań TTS używanych wyłącznie przez wyłączoną gramatykę", async () => {
    const { fakes, draft } = await generatedLesson(true);
    expect(draft.assets).toHaveLength(22);
    // Przedmiot z wyłączonym audio odpowiedzi i zdania feedbacku (jak po wyłączeniu obu flag).
    const services = createServices({ db, clock: new ManualClock(), media: fakes.settings, generation: fakes.deps,
      subjects: createSubjectRegistry([grammarWithoutSentenceAudio]) });
    for (let pass = 0; pass < 10; pass += 1) {
      const result = await runDueGenerationWork(services, { lesson: 0, deck: 0, tts: 50, images: 0 });
      if (result.processed === 0) break;
    }
    expect(fakes.tts.requests).toHaveLength(0);
    const runs = (await pool.query("select state from learning_app.generation_runs where kind='tts'")).rows;
    // Jedno uruchomienie na każdy odrębny zasób target_audio/feedback_audio szkicu.
    const distinct = (await pool.query<{ count: number }>(
      `select count(distinct ra.asset_id)::int as count
         from learning_app.revision_assets ra
         join learning_app.item_revisions ir on ir.id = ra.item_revision_id
        where ir.deck_version_id = $1 and ra.role in ('target_audio','feedback_audio')`,
      [draft.id],
    )).rows[0]!.count;
    expect(runs.length).toBe(distinct);
    expect(runs.every(row => row.state === "superseded")).toBe(true);
  });

  it("wspólne audio nadal powstaje, jeżeli potrzebuje go zestaw słówek", async () => {
    const { fakes, draft } = await generatedLesson(true);
    const services = createServices({ db, clock: new ManualClock(), media: fakes.settings, generation: fakes.deps });
    const answer = draft.exercises[0]!.answer;
    fakes.llm.queue({ items: [{ source: "Przykład", target: answer, acceptedAnswers: [], visualType: "none" }] });
    const vocabulary = await enqueueDeckGeneration(services, { prompt: "Przykład", idempotencyKey: randomUUID() });
    await executeGeneration(services, vocabulary.runId);
    const shared = (await pool.query(`select ra.asset_id from learning_app.revision_assets ra
      join learning_app.item_revisions ir on ir.id=ra.item_revision_id
      where ir.deck_id=$1 and ra.role='target_audio'`, [vocabulary.deckId])).rows[0].asset_id;
    expect(draft.assets.some(asset => asset.assetId === shared)).toBe(true);
    await executeMediaAsset(services, shared);
    expect((await pool.query("select state from learning_app.media_assets where id=$1", [shared])).rows[0].state).toBe("ready");
  });

  it("dwa workery nie przywracają anulowanego TTS po odczytaniu tej samej migawki pending", async () => {
    const { fakes, draft } = await generatedLesson(true);
    // Bez odczytu zdania: w popraw/przekształć zdanie równa się odpowiedzi, więc
    // `target_audio` i `feedback_audio` dzielą zasób, którego włączona rola nie anuluje.
    const services = createServices({ db, clock: new ManualClock(), media: fakes.settings, generation: fakes.deps,
      subjects: createSubjectRegistry([grammarWithoutSentenceAudio]) });
    const assetId = draft.assets[0]!.assetId!;
    const originalQuery = pool.query;
    let release!: () => void;
    const bothRead = new Promise<void>(resolve => { release = resolve; });
    let initialReads = 0;
    // Zachowujemy prawdziwy PostgreSQL i lifecycle; zatrzymujemy jedynie zwrot
    // dwóch początkowych SELECT-ów, aby oba workery miały tę samą starą migawkę.
    pool.query = (async (...args: unknown[]) => {
      const result = await (originalQuery as (...values: unknown[]) => Promise<unknown>).apply(pool, args);
      const text = typeof args[0] === "string" ? args[0] : (args[0] as { text?: string })?.text ?? "";
      if (initialReads < 2 && text.includes('from "learning_app"."media_assets"')
        && Array.isArray(args[1]) && args[1].includes(assetId)) {
        initialReads += 1;
        if (initialReads === 2) release();
        await bothRead;
      }
      return result;
    }) as typeof pool.query;
    try {
      await Promise.all([executeMediaAsset(services, assetId), executeMediaAsset(services, assetId)]);
    } finally {
      pool.query = originalQuery;
    }
    expect(initialReads).toBe(2);
    expect(fakes.tts.requests).toHaveLength(0);
    expect((await pool.query("select state from learning_app.media_assets where id=$1", [assetId])).rows[0].state).toBe("failed");
    expect((await pool.query("select state from learning_app.generation_runs where asset_id=$1", [assetId])).rows[0].state).toBe("superseded");
  });
});
