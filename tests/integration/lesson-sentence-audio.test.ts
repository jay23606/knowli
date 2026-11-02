import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  completePresentation, createChild, createLesson, createLessonDraftFromPublished, createServices, createSubjectRegistry, englishGrammarSubject,
  endSession, executeLessonGeneration, FakeAnswerGrader, runDueGenerationWork, fakeGraderDeps, nextTask, publishLessonDraft, readAttempt, readLessonDeck, startSession, submitAttempt,
} from "@learning/server";
import type { AttemptDto, AttemptInput, TaskDto } from "@learning/contracts";
import { lessonWorld } from "../fixtures/lesson-world";
import { buildTestServices, grammarWithoutSentenceAudio, ManualClock, testDatabase, truncateCoreTables } from "./helpers";
import { fakeGeneration } from "./fakes";

/**
 * Odczyt pełnego zdania po odpowiedzi (gramatyka): `feedback_audio` jest
 * planowane przy przygotowaniu materiału, nie blokuje publikacji i jest
 * uzgadniane także przy publikacji kopii starej lekcji.
 */

const { db, pool } = testDatabase();
const OBJECTIVE = "english_grammar.present_simple.third_person_s";
const cleanup: Array<() => Promise<void>> = [];

beforeEach(async () => {
  await truncateCoreTables();
  await pool.query(`truncate learning_app.child_objective_progress, learning_app.lesson_verdicts,
    learning_app.generation_runs, learning_app.revision_assets, learning_app.media_assets,
    learning_app.item_revision_skills, learning_app.item_revisions, learning_app.skill_versions,
    learning_app.learning_items, learning_app.deck_versions, learning_app.decks cascade`);
});
afterEach(async () => { for (const dispose of cleanup.splice(0)) await dispose(); });
afterAll(() => pool.end());

async function generatedGrammarLesson(feedbackSentence = true) {
  const fakes = await fakeGeneration();
  cleanup.push(fakes.dispose);
  const services = createServices({ db, clock: new ManualClock(), media: fakes.settings, generation: fakes.deps,
    ...(feedbackSentence ? {} : { subjects: createSubjectRegistry([grammarWithoutSentenceAudio]) }),
  });
  const run = await createLesson(services, {
    subjectId: "english_grammar", topicId: "present_simple", objectiveIds: [OBJECTIVE],
    material: "He plays football. She reads books. She watches TV.", poolSize: 20, clientRequestId: randomUUID(),
  });
  await executeLessonGeneration(services, run.runId);
  const draft = (await readLessonDeck(services, run.deckId)).draft!;
  return { services, run, draft, fakes };
}

const feedbackRows = async (versionId: string) => (await pool.query<{ text: string; state: string }>(
  `select ma.metadata->>'text' as text, ma.state
     from learning_app.revision_assets ra
     join learning_app.item_revisions ir on ir.id = ra.item_revision_id
     join learning_app.media_assets ma on ma.id = ra.asset_id
    where ir.deck_version_id = $1 and ra.role = 'feedback_audio'`,
  [versionId],
)).rows;

const mediaCount = async () => (await pool.query("select count(*)::int as count from learning_app.media_assets")).rows[0].count as number;

describe("lekcja gramatyki — nagranie zdania feedbacku", () => {
  it("generacja zleca feedback_audio, a rodzic go nie widzi i publikacja na nie nie czeka", async () => {
    const { services, draft } = await generatedGrammarLesson();
    const rows = await feedbackRows(draft.id);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.state === "pending")).toBe(true);
    expect(draft.assets).toEqual([]);
    await expect(publishLessonDraft(services, draft.id, draft.editNumber)).resolves.toEqual({ deckVersionId: draft.id });
  });

  it("nowa wersja starej lekcji (bez feedback_audio) po publikacji zleca nowe nagrania, a drugie przejście nie dubluje zasobów", async () => {
    // Stara lekcja: wygenerowana i opublikowana, gdy przedmiot nie miał jeszcze flagi.
    const { services: old, run, draft, fakes } = await generatedGrammarLesson(false);
    await publishLessonDraft(old, draft.id, draft.editNumber);
    expect(await feedbackRows(draft.id)).toEqual([]);
    expect(await mediaCount()).toBe(0);
    expect((await pool.query("select count(*)::int as count from learning_app.generation_runs where kind = 'tts'")).rows[0].count).toBe(0);

    // Po wdrożeniu (domyślny rejestr z flagą): kopia + publikacja uzgadnia media.
    const current = createServices({ db, clock: new ManualClock(), media: fakes.settings, generation: fakes.deps });
    const copy = await createLessonDraftFromPublished(current, run.deckId);
    expect(await feedbackRows(copy.id)).toEqual([]);
    await publishLessonDraft(current, copy.id, copy.editNumber);
    const created = await feedbackRows(copy.id);
    expect(created.length).toBeGreaterThan(0);
    expect(created.every((row) => row.state === "pending")).toBe(true);
    const mediaAfterFirst = await mediaCount();
    expect(mediaAfterFirst).toBeGreaterThan(0);
    const ttsRuns = async () => (await pool.query("select count(*)::int as count from learning_app.generation_runs where kind = 'tts' and state = 'queued'")).rows[0].count as number;
    const runsAfterFirst = await ttsRuns();
    expect(runsAfterFirst).toBe(mediaAfterFirst);

    const second = await createLessonDraftFromPublished(current, run.deckId);
    await publishLessonDraft(current, second.id, second.editNumber);
    expect((await feedbackRows(second.id)).map((row) => row.text).sort()).toEqual(created.map((row) => row.text).sort());
    expect(await mediaCount()).toBe(mediaAfterFirst);
    expect(await ttsRuns()).toBe(runsAfterFirst);
  });

  it("worker syntezuje zdania feedbacku (en-GB) i nie unieważnia ich przy włączonej fladze", async () => {
    const { fakes, draft } = await generatedGrammarLesson();
    const services = createServices({ db, clock: new ManualClock(), media: fakes.settings, generation: fakes.deps });
    for (let pass = 0; pass < 20; pass += 1) {
      const result = await runDueGenerationWork(services, { lesson: 0, deck: 0, tts: 50, images: 0 });
      if (result.processed === 0) break;
    }
    const rows = await feedbackRows(draft.id);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.state === "ready")).toBe(true);
    const requested = fakes.tts.requests.filter((request) => request.locale === "en-GB").map((request) => request.text);
    for (const row of rows) expect(requested).toContain(row.text);
    // To pełne zdania (bez znacznika luki), nie same odpowiedzi.
    expect(rows.some((row) => row.text.split(" ").length >= 3)).toBe(true);
    expect(rows.every((row) => !row.text.includes("___"))).toBe(true);
    const runs = (await pool.query<{ state: string }>("select state from learning_app.generation_runs where kind = 'tts'")).rows;
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.some((run) => run.state === "superseded")).toBe(false);
    expect(runs.some((run) => run.state === "failed")).toBe(false);
  });

  it("CHECK roli przyjmuje feedback_audio", async () => {
    const { draft } = await generatedGrammarLesson();
    const revision = (await pool.query(`select id from learning_app.item_revisions where deck_version_id = $1 limit 1`, [draft.id])).rows[0].id;
    await pool.query(`delete from learning_app.revision_assets where item_revision_id = $1 and role = 'feedback_audio'`, [revision]);
    await expect(pool.query(
      `insert into learning_app.revision_assets (item_revision_id, role, expected_fingerprint, state) values ($1, 'feedback_audio', 'fp', 'pending')`, [revision],
    )).resolves.toBeDefined();
    await expect(pool.query(
      `insert into learning_app.revision_assets (item_revision_id, role, expected_fingerprint, state) values ($1, 'bogus_audio', 'fp', 'pending')`, [revision],
    )).rejects.toThrow(/revision_assets_role_allowed/);
  });
});

type Services = ReturnType<typeof buildTestServices>["services"];

/** Services z fake graderem (selektor wydaje wtedy typy zależne od modelu). */
function graderServices(grader: FakeAnswerGrader = new FakeAnswerGrader()): Services {
  const { services, clock } = buildTestServices();
  return createServices({
    db: (services as unknown as { db: Parameters<typeof createServices>[0]["db"] }).db,
    clock,
    generation: {} as Parameters<typeof createServices>[0]["generation"],
    grader: fakeGraderDeps({ provider: grader }),
  });
}

async function answerKeyOf(taskId: string): Promise<Record<string, unknown>> {
  return (await pool.query<{ answerKey: Record<string, unknown> }>(
    `select answer_key as "answerKey" from learning_app.session_tasks where id = $1`, [taskId],
  )).rows[0]!.answerKey;
}

async function answerCorrectly(services: Services, task: TaskDto): Promise<void> {
  const key = await answerKeyOf(task.taskId);
  if (task.exerciseType === "lesson_choice" || task.exerciseType === "lesson_short_answer" || task.exerciseType === "lesson_notice") {
    await submitAttempt(services, { taskId: task.taskId, clientAttemptId: randomUUID(), modality: "choice", optionId: key.correctOptionId as string });
  } else if (task.exerciseType === "lesson_order") {
    await submitAttempt(services, { taskId: task.taskId, clientAttemptId: randomUUID(), modality: "sequence", itemIds: key.itemIds as string[] });
  } else {
    await submitAttempt(services, { taskId: task.taskId, clientAttemptId: randomUUID(), modality: "text", text: key.answer as string });
  }
}

const PRODUCTIVE = new Set(["lesson_gap", "lesson_error_fix", "lesson_transform", "lesson_open_answer"]);

async function issueUntil(services: Services, sessionId: string, type: string, max = 40): Promise<TaskDto> {
  const advance = PRODUCTIVE.has(type);
  for (let i = 0; i < max; i++) {
    const task = await nextTask(services, sessionId);
    if (task === null) throw new Error(`sesja skończyła się przed ${type}`);
    if (task.exerciseType === "lesson_card") {
      await completePresentation(services, { taskId: task.taskId });
      continue;
    }
    if (task.exerciseType === type) return task;
    if (advance) await answerCorrectly(services, task);
    else await submitAttempt(services, { taskId: task.taskId, clientAttemptId: randomUUID(), modality: "skip" });
  }
  throw new Error(`nie doczekano ćwiczenia ${type}`);
}

/** Nagranie zdania przypięte do rewizji wydanego zadania (oczekiwane `correctAudioAssetId`). */
async function feedbackAssetOf(taskId: string): Promise<string> {
  return (await pool.query<{ assetId: string }>(
    `select ra.asset_id as "assetId" from learning_app.revision_assets ra
       join learning_app.session_tasks st on st.item_revision_id = ra.item_revision_id
      where st.id = $1 and ra.role = 'feedback_audio'`, [taskId],
  )).rows[0]!.assetId;
}

interface AudioEventRow { occurredAt: Date; sealed: boolean; stepId: string; exposures: string[] }

async function audioEvents(taskId: string): Promise<AudioEventRow[]> {
  return (await pool.query<AudioEventRow>(
    `select le.occurred_at as "occurredAt", le.sealed, le.step_id as "stepId",
            coalesce(array_agg(ee.target_key) filter (where ee.target_key is not null), '{}') as exposures
       from learning_app.learning_events le
       left join learning_app.event_exposures ee on ee.event_id = le.id
      where le.task_id = $1 and le.kind = 'audio_issued'
      group by le.id order by le.occurred_at`, [taskId],
  )).rows;
}

async function independentOf(attemptId: string): Promise<boolean | null> {
  return (await pool.query<{ independent: boolean }>(
    "select independent from learning_app.assessments where attempt_id = $1 and skill = 'objective'", [attemptId],
  )).rows[0]?.independent ?? null;
}

type Answer = (task: TaskDto, key: Record<string, unknown>) => Record<string, unknown>;

interface Scenario {
  type: string;
  services: () => Services;
  answer: Answer;
  withPriorSuccess?: boolean;
  /** Dodatkowe zatwierdzone warianty przekształcenia (`lessonWorld.transformVariants`). */
  transformVariants?: readonly string[];
}

/** Jedno dziecko, jedna lekcja (z nagraniem albo bez), odpowiedź na pierwsze zadanie typu. */
async function play(scenario: Scenario, feedbackAudio: "ready" | "ready-approved" | "pending" | null) {
  const services = scenario.services();
  const now = services.clock.now();
  const child = await createChild(services, { displayName: "Zdanie", avatarKey: "owl" });
  const lesson = await lessonWorld(pool, {
    childId: child.id, richPool: true, now, withObjectiveAssessment: scenario.withPriorSuccess ?? false,
    ...(feedbackAudio ? { withFeedbackAudio: feedbackAudio } : {}),
    ...(scenario.transformVariants ? { transformVariants: scenario.transformVariants } : {}),
  });
  const session = await startSession(services, { childId: child.id, deckId: lesson.deckId, microphoneEnabled: false });
  const task = await issueUntil(services, session.sessionId, scenario.type);
  const key = await answerKeyOf(task.taskId);
  const input = { taskId: task.taskId, clientAttemptId: randomUUID(), ...scenario.answer(task, key) } as AttemptInput;
  const attempt = await submitAttempt(services, input);
  return { services, task, key, input, attempt, independent: await independentOf(attempt.attemptId) };
}

const choiceCorrect: Answer = (_task, key) => ({ modality: "choice", optionId: key.correctOptionId as string });
const choiceWrong: Answer = (task, key) => ({
  modality: "choice",
  optionId: (task.prompt as { options: { id: string }[] }).options.find((o) => o.id !== key.correctOptionId)!.id,
});
const text = (value: string): Answer => () => ({ modality: "text", text: value });
const plain = () => buildTestServices().services;

const WITH_AUDIO: Array<{ name: string; kind: string; scenario: Scenario }> = [
  { name: "wybór poprawny", kind: "great", scenario: { type: "lesson_choice", services: plain, answer: choiceCorrect } },
  { name: "wybór błędny", kind: "incorrect", scenario: { type: "lesson_choice", services: plain, answer: choiceWrong } },
  { name: "„Nie pamiętam”", kind: "incorrect", scenario: { type: "lesson_choice", services: plain, answer: () => ({ modality: "dont_remember" }) } },
  {
    name: "literówka poza focus (deterministycznie)", kind: "lesson_almost",
    scenario: { type: "lesson_transform", services: () => graderServices(), answer: text("shee plays"), withPriorSuccess: true },
  },
  {
    name: "luka „prawie” (werdykt modelu)", kind: "lesson_almost",
    scenario: {
      type: "lesson_gap", withPriorSuccess: true, answer: text("gose"),
      services: () => graderServices(new FakeAnswerGrader().onDefault({ raw: { verdict: "almost", errorCategory: null, fragments: ["gose"], note: "typo" } })),
    },
  },
  {
    name: "werdykt modelu model_incorrect", kind: "lesson_hint",
    scenario: {
      type: "lesson_transform", withPriorSuccess: true, answer: text("she play"),
      services: () => graderServices(new FakeAnswerGrader().onDefault({ raw: { verdict: "incorrect", errorCategory: "missing_ending", fragments: ["play"], note: "brak -s" } })),
    },
  },
];

/** Wiersz opublikowanej rewizji zwykle zostaje `pending` (publikacja nie czeka na media); `approved` to drugi możliwy stan. */
const ROW_STATES = ["ready", "ready-approved"] as const;

describe("feedback lekcji gramatyki ujawnia nagranie zdania", () => {
  for (const rowState of ROW_STATES) for (const { name, kind, scenario } of WITH_AUDIO) {
    it(`${name} [${rowState}] → ${kind} z correctAudioAssetId i jednym zapieczętowanym audio_issued po odpowiedzi`, async () => {
      const played = await play(scenario, rowState);
      const { attempt, task, key } = played;
      expect(attempt.feedback?.kind).toBe(kind);
      expect(attempt.feedback?.correctAudioAssetId).toBe(await feedbackAssetOf(task.taskId));

      const events = await audioEvents(task.taskId);
      expect(events).toHaveLength(1);
      expect(events[0]!.sealed).toBe(true);
      expect(events[0]!.occurredAt.getTime()).toBeGreaterThan(new Date(attempt.receivedAt).getTime());
      expect(events[0]!.exposures).toEqual([key.targetKey]);

      // Samodzielność próby jak przy tej samej odpowiedzi bez nagrania.
      const baseline = await play(scenario, null);
      expect(baseline.attempt.feedback?.kind).toBe(kind);
      expect(baseline.attempt.feedback?.correctAudioAssetId).toBeUndefined();
      expect(await audioEvents(baseline.task.taskId)).toEqual([]);
      expect(played.independent).toBe(baseline.independent);
    });
  }

  it("odpowiedź produktywna po wcześniejszym sukcesie jest samodzielna także z odczytem zdania", async () => {
    const scenario: Scenario = { type: "lesson_gap", services: plain, answer: (_task, key) => ({ modality: "text", text: key.answer as string }), withPriorSuccess: true };
    const played = await play(scenario, "ready");
    expect(played.attempt.feedback?.correctAudioAssetId).toBe(await feedbackAssetOf(played.task.taskId));
    expect(played.independent).toBe(true);
    expect((await play(scenario, null)).independent).toBe(true);
  });

  it("ponowny odczyt i idempotentne ponowienie zwracają ten sam identyfikator bez drugiego audio_issued", async () => {
    const { services, attempt, task, input } = await play(WITH_AUDIO[0]!.scenario, "ready");
    const assetId = attempt.feedback?.correctAudioAssetId;
    expect(assetId).toBeTruthy();
    const read: AttemptDto = await readAttempt(services, attempt.attemptId);
    expect(read.feedback?.correctAudioAssetId).toBe(assetId);
    const retried = await submitAttempt(services, input);
    expect(retried.feedback?.correctAudioAssetId).toBe(assetId);
    expect(await audioEvents(task.taskId)).toHaveLength(1);
  });
});

describe("feedback lekcji bez nagrania zdania", () => {
  it("„Pomiń” — brak feedbacku i brak audio_issued", async () => {
    const { attempt, task } = await play({ type: "lesson_choice", services: plain, answer: () => ({ modality: "skip" }) }, "ready");
    expect(attempt.feedback).toBeNull();
    expect(await audioEvents(task.taskId)).toEqual([]);
  });

  it("„prawie” z najbliższym zatwierdzonym wariantem ≠ kanoniczny — omówienie pokazuje wariant, bez correctAudioAssetId i audio_issued", async () => {
    // Literówka poza focus w wariancie dłuższym od kanonicznego „she plays”: najbliższy wariant to „Yes, she plays.”.
    const variant = "Yes, she plays.";
    const { attempt, task, key } = await play({
      type: "lesson_transform", services: () => graderServices(), answer: text("Yess, she plays."), withPriorSuccess: true, transformVariants: [variant],
    }, "ready");
    expect(key.answer).toBe("she plays");
    expect(key.acceptedAnswers).toContain(variant);
    expect(attempt.feedback).toMatchObject({ kind: "lesson_almost", correctText: variant });
    expect(attempt.feedback?.correctAudioAssetId).toBeUndefined();
    expect(attempt.taskState).toBe("answered");
    expect(await audioEvents(task.taskId)).toEqual([]);
    // Nagranie zadania jest w kluczu — brak w feedbacku wynika z bramki wariantu, nie z braku zasobu.
    expect(key.feedbackAudioAssetId).toBe(await feedbackAssetOf(task.taskId));
  });

  it("not_assessed (brak modelu przy no_match) — bez correctAudioAssetId i audio_issued", async () => {
    const { attempt, task } = await play({ type: "lesson_gap", services: plain, answer: text("completely wrong"), withPriorSuccess: true }, "ready");
    expect(attempt.feedback?.kind).toBe("not_assessed");
    expect(attempt.feedback?.correctAudioAssetId).toBeUndefined();
    expect(await audioEvents(task.taskId)).toEqual([]);
  });

  it("kartkówka — feedback null i brak audio_issued", async () => {
    const services = plain();
    const child = await createChild(services, { displayName: "Kartkówka", avatarKey: "owl" });
    const lesson = await lessonWorld(pool, { childId: child.id, richPool: true, now: services.clock.now(), testDate: "2026-10-20", withFeedbackAudio: "ready" });
    const session = await startSession(services, { childId: child.id, deckId: lesson.deckId, microphoneEnabled: false, mode: "mock_test" });
    let checked = 0;
    for (let i = 0; i < 20; i++) {
      const task = await nextTask(services, session.sessionId);
      if (!task) break;
      if (task.exerciseType === "lesson_card") {
        await completePresentation(services, { taskId: task.taskId });
        continue;
      }
      expect((await answerKeyOf(task.taskId)).feedbackAudioAssetId).toBeUndefined();
      const attempt = await submitAttempt(services, { taskId: task.taskId, clientAttemptId: randomUUID(), modality: "dont_remember" });
      expect(attempt.feedback).toBeNull();
      expect(await audioEvents(task.taskId)).toEqual([]);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("kartkówka nie odpytuje feedback_audio; trening tak (kontrola)", async () => {
    const services = plain();
    const queries: string[] = [];
    const originalQuery = pool.query;
    const originalConnect = pool.connect;
    let recording = true;
    const record = (args: unknown[]) => {
      const text = typeof args[0] === "string" ? args[0] : (args[0] as { text?: string })?.text ?? "";
      queries.push(`${text} ${JSON.stringify(Array.isArray(args[1]) ? args[1] : [])}`);
    };
    // Zachowujemy prawdziwy PostgreSQL; zbieramy teksty zapytań i parametry z puli oraz z klientów transakcji.
    pool.query = (async (...args: unknown[]) => {
      record(args);
      return (originalQuery as (...values: unknown[]) => Promise<unknown>).apply(pool, args);
    }) as typeof pool.query;
    pool.connect = ((...args: unknown[]) => {
      // Wywołania z callbackiem (wewnętrzne `pool.query`) przechodzą bez zmian; transakcje Drizzle używają wersji z obietnicą.
      if (typeof args[0] === "function") return (originalConnect as (...values: unknown[]) => unknown).apply(pool, args);
      return (originalConnect as (...values: unknown[]) => Promise<{ query: (...values: unknown[]) => Promise<unknown> }>).apply(pool, args).then((client) => {
        const clientQuery = client.query;
        // Klient wraca do puli: po teście zapis się wyłącza, a nie zdejmuje opakowania.
        client.query = (...values: unknown[]) => { if (recording) record(values); return clientQuery.apply(client, values); };
        return client;
      });
    }) as unknown as typeof pool.connect;
    try {
      const childA = await createChild(services, { displayName: "Kartkówka", avatarKey: "owl" });
      const mock = await lessonWorld(pool, { childId: childA.id, richPool: true, now: services.clock.now(), testDate: "2026-10-20", withFeedbackAudio: "ready" });
      queries.length = 0;
      await startSession(services, { childId: childA.id, deckId: mock.deckId, microphoneEnabled: false, mode: "mock_test" });
      expect(queries.length).toBeGreaterThan(0);
      expect(queries.filter((query) => query.includes("feedback_audio"))).toEqual([]);

      const childB = await createChild(services, { displayName: "Trening", avatarKey: "owl" });
      const training = await lessonWorld(pool, { childId: childB.id, richPool: true, now: services.clock.now(), withFeedbackAudio: "ready" });
      queries.length = 0;
      await startSession(services, { childId: childB.id, deckId: training.deckId, microphoneEnabled: false });
      expect(queries.filter((query) => query.includes("feedback_audio")).length).toBeGreaterThan(0);
    } finally {
      recording = false;
      pool.query = originalQuery;
      pool.connect = originalConnect;
    }
  });

  it("model_other (zadanie zostaje issued) — incorrect z correctText bez nagrania; ponowienie bez wsparcia model_audio", async () => {
    const { services, attempt, task } = await play({
      type: "lesson_transform", withPriorSuccess: true, answer: text("she play"),
      services: () => graderServices(new FakeAnswerGrader().onDefault({ raw: { verdict: "incorrect", errorCategory: "other", fragments: [], note: "off topic" } })),
    }, "ready");
    expect(attempt.feedback?.kind).toBe("incorrect");
    expect(attempt.feedback?.correctText).toBeTruthy();
    expect(attempt.feedback?.correctAudioAssetId).toBeUndefined();
    expect(attempt.taskState).toBe("issued");
    expect(await audioEvents(task.taskId)).toEqual([]);

    const retry = await submitAttempt(services, { taskId: task.taskId, clientAttemptId: randomUUID(), modality: "text", text: "she plays" });
    expect(retry.taskState).toBe("answered");
    const context = (await pool.query<{ context: { assistance: string[] } }>(
      "select context from learning_app.attempts where id = $1", [retry.attemptId],
    )).rows[0]!.context;
    expect(context.assistance).not.toContain("model_audio");
  });

  it("nagranie pending przy wydaniu, ready przy odpowiedzi — feedback bez nagrania", async () => {
    const services = plain();
    const child = await createChild(services, { displayName: "Później", avatarKey: "owl" });
    const lesson = await lessonWorld(pool, { childId: child.id, richPool: true, now: services.clock.now(), withFeedbackAudio: "pending" });
    const session = await startSession(services, { childId: child.id, deckId: lesson.deckId, microphoneEnabled: false });
    const task = await issueUntil(services, session.sessionId, "lesson_choice");
    await pool.query(
      `update learning_app.media_assets
          set state = 'ready', storage_key = 'blob/' || id, mime_type = 'audio/mpeg', byte_count = 3, content_sha256 = $1, lease_token = null
        where state = 'pending'`,
      ["0".repeat(64)],
    );
    const key = await answerKeyOf(task.taskId);
    const attempt = await submitAttempt(services, { taskId: task.taskId, clientAttemptId: randomUUID(), modality: "choice", optionId: key.correctOptionId as string });
    expect(attempt.feedback?.kind).toBe("great");
    expect(attempt.feedback?.correctAudioAssetId).toBeUndefined();
    expect(await audioEvents(task.taskId)).toEqual([]);
  });
});

describe("stara lekcja po wdrożeniu odczytu zdania", () => {
  it("nowa wersja starej lekcji: po workerze odczyt działa w sesji", async () => {
    const { services: old, run, draft, fakes } = await generatedGrammarLesson(false);
    await publishLessonDraft(old, draft.id, draft.editNumber);

    const clock = new ManualClock();
    const current = createServices({ db, clock, media: fakes.settings, generation: fakes.deps });
    const copy = await createLessonDraftFromPublished(current, run.deckId);
    await publishLessonDraft(current, copy.id, copy.editNumber);
    for (let pass = 0; pass < 20; pass += 1) {
      const result = await runDueGenerationWork(current, { lesson: 0, deck: 0, tts: 50, images: 0 });
      if (result.processed === 0) break;
    }
    // Worker opróżnił kolejkę: bez tego brak nagrania w feedbacku wyglądałby jak błąd sesji.
    const synthesized = await feedbackRows(copy.id);
    expect(synthesized.length).toBeGreaterThan(0);
    expect(synthesized.filter((row) => row.state !== "ready")).toEqual([]);

    const child = await createChild(current, { displayName: "Stara lekcja", avatarKey: "owl" });
    await pool.query(
      "insert into learning_app.assignments (id, child_id, deck_id, test_date, test_goals) values ($1, $2, $3, null, null)",
      [randomUUID(), child.id, run.deckId],
    );
    // W wygenerowanej lekcji zdanie do odczytu mają tylko luki i odpowiedzi otwarte (wybory nie mają jednej luki w treści),
    // a typy produktywne pojawiają się po sukcesach z kolejnych sesji: gramy poprawnie do pierwszego takiego zadania.
    let task: TaskDto | null = null;
    for (let round = 0; round < 8 && !task; round += 1) {
      const session = await startSession(current, { childId: child.id, deckId: run.deckId, microphoneEnabled: false });
      for (let step = 0; step < 40 && !task; step += 1) {
        const next = await nextTask(current, session.sessionId);
        if (next === null) break;
        if (next.exerciseType === "lesson_card") { await completePresentation(current, { taskId: next.taskId }); continue; }
        if (PRODUCTIVE.has(next.exerciseType)) task = next;
        else await answerCorrectly(current, next);
      }
      if (!task) { await endSession(current, session.sessionId); clock.advanceHours(1); }
    }
    expect(task).not.toBeNull();
    const issued = task!;
    const key = await answerKeyOf(issued.taskId);
    const attempt = await submitAttempt(current, { taskId: issued.taskId, clientAttemptId: randomUUID(), modality: "text", text: key.answer as string });

    expect(attempt.feedback?.correctAudioAssetId).toBe(await feedbackAssetOf(issued.taskId));
    const events = await audioEvents(issued.taskId);
    expect(events).toHaveLength(1);
    expect(events[0]!.occurredAt.getTime()).toBeGreaterThan(new Date(attempt.receivedAt).getTime());
  });
});
